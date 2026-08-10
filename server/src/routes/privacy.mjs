/**
 * N17 — right-to-erasure. Port of handlers/privacy.rs.
 *
 * ── The ORDER of the first four steps is the whole design ───────────────────────────────────────
 * 1. Authorize. `require_self_or_any(learnerId, [admin, ops])` runs FIRST, and must. A learner may
 *    only ever pass their own id, so only admin/ops — already trusted with every row in the tenant
 *    — can reach a 404 at all. Inverting steps 1 and 2 turns the 404 into a learner-enumeration
 *    oracle.
 * 2. Check the learner exists → 404. `privacy_jobs.learner_id` REFERENCES users(id), so without
 *    this the INSERT violates the FK and surfaces as a 500 — indistinguishable from a real database
 *    failure on a right-to-erasure endpoint, and it invites a retry that can never succeed.
 * 3. Capture the bounded manifest and commit a durable intent before deletion. A crash can then
 *    repeat the idempotent erase without losing which objects and records were accepted.
 * 4. Erase audio, then commit the manifest/cascade and durable-job completion in one fenced tenant
 *    transaction. RLS isolates it and a stale worker cannot apply the multi-table delete.
 *
 * Step 2 sits BEFORE the durable intent and erase deliberately. It reads like a detail and is not: with the audio store
 * unreachable, an unknown learner used to return 502 ("transient, retry me") instead of 404
 * ("permanent, do not"). Wrong-signal-for-retry is the defect that ordering exists to fix, so it
 * must not survive in the storage-outage case. A failed dependency can leave only the explicit retryable
 * intent; it never partially deletes the domain cascade.
 */
import { createHash, randomUUID } from "node:crypto";

import { waitForJobResult } from "../jobs/wait-for-job.mjs";
import { ApiError, NotFound, RejectionError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { createDeadline } from "../lib/deadline.mjs";
import { proxy } from "../lib/proxy.mjs";

const newId = (prefix) => `${prefix}-${randomUUID()}`;

/**
 * Erase the learner's recorded audio from the injected private object store.
 *
 * The DB cascade only removes derived records; raw audio remains in object storage unless this
 * boundary deletes it. Deletion is idempotent, so a durable retry is safe.
 */
async function eraseLearnerAudio(ctx, tenantId, learnerId, traceId) {
  if (!ctx.audioObjectStore) {
    throw new ApiError("audio erasure service unavailable", 502);
  }
  try {
    const result = await ctx.audioObjectStore.deleteLearner(
      { tenantId, learnerId },
      { signal: ctx.deadline?.signal },
    );
    if (result.fullyErased !== true) {
      throw new Error("audio object storage reported an incomplete learner erasure");
    }
    console.info(
      `privacy delete: erased ${result.deletedObjectKeys.length} audio object(s) and ${result.deletedOtherObjectKeys.length} other object(s) trace=${JSON.stringify(traceId)}`,
    );
    return result.deletedObjectKeys;
  } catch {
    console.error("privacy delete: object storage erase error");
    throw new ApiError("audio erasure service unavailable", 502);
  }
}

async function capturePrivacyManifest(ctx, tenantId, learnerId, kind) {
  const includedRecords = await ctx.db.withTenant(tenantId, async (tx) => {
    const [learner] = await tx`
      SELECT 1 FROM users WHERE id = ${learnerId} AND tenant_id = ${tenantId}`;
    if (!learner) throw NotFound();
    const sessions = await tx`
      SELECT id FROM recitation_sessions
      WHERE tenant_id = ${tenantId} AND learner_id = ${learnerId} ORDER BY id`;
    const progress = await tx`
      SELECT ayah_ref FROM learner_progress
      WHERE tenant_id = ${tenantId} AND learner_id = ${learnerId} ORDER BY ayah_ref`;
    const agentRuns = await tx`
      SELECT id FROM agent_runs
      WHERE tenant_id = ${tenantId} AND learner_id = ${learnerId} ORDER BY id`;
    const pilotSessions = await tx`
      SELECT id FROM pilot_sessions
      WHERE tenant_id = ${tenantId} AND learner_id = ${learnerId} ORDER BY id`;
    const pilotInvitations = await tx`
      SELECT id FROM pilot_invitations
      WHERE tenant_id = ${tenantId} AND learner_id = ${learnerId} ORDER BY id`;
    const [deviceIdentity] = await tx`
      SELECT
        (SELECT COUNT(*)::integer FROM device_sessions
          WHERE tenant_id = ${tenantId} AND user_id = ${learnerId}) AS session_count,
        (SELECT COUNT(*)::integer FROM device_enrollment_invitations
          WHERE tenant_id = ${tenantId} AND user_id = ${learnerId}) AS invitation_count`;

    const deviceRecords = [];
    if (deviceIdentity.session_count > 0) {
      deviceRecords.push(`device_session_count:${deviceIdentity.session_count}`);
    }
    if (deviceIdentity.invitation_count > 0) {
      deviceRecords.push(`device_enrollment_invitation_count:${deviceIdentity.invitation_count}`);
    }

    return [
      ...sessions.map((r) => r.id ?? ""),
      ...progress.map((r) => `learner_progress:${r.ayah_ref ?? ""}`),
      ...agentRuns.map((r) => `agent_run:${r.id ?? ""}`),
      ...pilotSessions.map((r) => `pilot_session:${r.id ?? ""}`),
      ...pilotInvitations.map((r) => `pilot_invitation:${r.id ?? ""}`),
      ...deviceRecords,
    ];
  });

  if (!ctx.audioObjectStore) {
    throw new ApiError(
      kind === "delete" ? "audio erasure service unavailable" : "audio export service unavailable",
      502,
    );
  }

  let audioObjectKeys;
  try {
    audioObjectKeys = (
      await ctx.audioObjectStore.listLearner(
        { tenantId, learnerId },
        { signal: ctx.deadline?.signal },
      )
    ).map((object) => object.objectKey);
  } catch {
    throw new ApiError(
      kind === "delete" ? "audio erasure service unavailable" : "audio export service unavailable",
      502,
    );
  }
  return {
    audioObjectKeys,
    includedRecords: [
      ...includedRecords,
      ...audioObjectKeys.map((key) => `audio_object:${key}`),
    ],
  };
}

async function commitPrivacyInTransaction({
  tx,
  actor,
  learnerId,
  kind,
  includedRecords,
  audioObjectKeysDeleted,
  traceId,
}) {
    const deletedRecords = kind === "delete" ? [...includedRecords] : [];

    const jobId = newId("privacy-job");
    const auditId = newId("audit");
    const action = kind === "delete" ? "privacy.delete.requested" : "privacy.export.requested";

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, ${action}, 'privacy_job', ${jobId},
              ${tx.json({ trace_id: traceId, kind })})`;

    await tx`
      INSERT INTO privacy_jobs
        (id, tenant_id, learner_id, kind, included_records, deleted_records,
         audio_object_keys_deleted, audit_event_id)
      VALUES (${jobId}, ${actor.tenantId}, ${learnerId}, ${kind}, ${tx.json(includedRecords)},
              ${tx.json(deletedRecords)}, ${tx.json(audioObjectKeysDeleted)}, ${auditId})`;

    if (kind === "delete") {
      await tx`
        DELETE FROM learner_progress
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

      // Native device identity contains credentials, so erase every generation and invitation
      // before any later user-erasure workflow can remove the user row. The privacy manifest carries
      // only aggregate counts; raw credential material and stored hashes never cross this boundary.
      await tx`
        DELETE FROM device_sessions
        WHERE tenant_id = ${actor.tenantId} AND user_id = ${learnerId}`;
      await tx`
        DELETE FROM device_enrollment_invitations
        WHERE tenant_id = ${actor.tenantId} AND user_id = ${learnerId}`;

      // FK-safe order: teacher_reviews -> tajweed_findings -> word_alignments -> session-owned rows.
      // EVERY derived-record delete is scoped through THIS learner's tenant-owned sessions;
      // otherwise one learner's erasure removes another learner's reviewed findings.
      await tx`
        DELETE FROM teacher_reviews
        WHERE tenant_id = ${actor.tenantId}
          AND finding_id IN (
            SELECT tf.id FROM tajweed_findings tf
            JOIN word_alignments wa ON wa.id = tf.alignment_id AND wa.tenant_id = tf.tenant_id
            JOIN recitation_sessions rs ON rs.id = wa.session_id AND rs.tenant_id = wa.tenant_id
            WHERE tf.tenant_id = ${actor.tenantId} AND rs.learner_id = ${learnerId})`;

      await tx`
        DELETE FROM tajweed_findings
        WHERE tenant_id = ${actor.tenantId}
          AND alignment_id IN (
            SELECT wa.id FROM word_alignments wa
            JOIN recitation_sessions rs ON rs.id = wa.session_id AND rs.tenant_id = wa.tenant_id
            WHERE wa.tenant_id = ${actor.tenantId} AND rs.learner_id = ${learnerId})`;

      await tx`
        DELETE FROM word_alignments
        WHERE tenant_id = ${actor.tenantId}
          AND session_id IN (
            SELECT id FROM recitation_sessions
            WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId})`;

      // Session-owned rows before the sessions themselves. Two tables, spelled out rather than
      // interpolated: the Rust builds this SQL with format!() over a fixed list, and a loop that
      // interpolates a table name is the one shape that must never take a value from a request.
      await tx`
        DELETE FROM audio_chunks
        WHERE tenant_id = ${actor.tenantId}
          AND session_id IN (
            SELECT id FROM recitation_sessions
            WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId})`;
      await tx`
        DELETE FROM alignment_runs
        WHERE tenant_id = ${actor.tenantId}
          AND session_id IN (
            SELECT id FROM recitation_sessions
            WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId})`;

      await tx`
        DELETE FROM realtime_session_tickets
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
      await tx`
        DELETE FROM recitation_sessions
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
      // NOTE the column: consent_records keys on user_id, not learner_id.
      await tx`
        DELETE FROM consent_records
        WHERE tenant_id = ${actor.tenantId} AND user_id = ${learnerId}`;
      await tx`
        DELETE FROM pilot_sessions
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
      await tx`
        DELETE FROM pilot_invitations
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
      await tx`
        DELETE FROM agent_runs
        WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
    }

    return { response: {
      id: jobId,
      tenantId: actor.tenantId,
      learnerId,
      kind,
      includedRecords,
      deletedRecords,
      audioObjectKeysDeleted,
      auditEventId: auditId,
    } };
}

/** External privacy work is retryable; its manifest was durably captured before deletion. */
export async function preparePrivacyWorkflow({ ctx, job, signal }) {
  const deadline = createDeadline(ctx.upstreamTimeoutMs, { parentSignal: signal });
  const kind = job.kind === "privacy.delete" ? "delete" : "export";
  const learnerId = job.payload.learnerId;
  let audioObjectKeysDeleted = [];
  if (kind === "delete") {
    const erased = await eraseLearnerAudio(
      { ...ctx, deadline },
      job.tenantId,
      learnerId,
      job.payload.traceId,
    );
    // Local storage inventory was captured in the durable intent. Unioning the repeat result means
    // a crash after deletion can return the original receipt even though the idempotent retry finds
    // no remaining objects.
    audioObjectKeysDeleted = [...new Set([
      ...job.payload.audioObjectKeys,
      ...erased,
    ])];
  }
  const includedRecords = [...new Set([
    ...job.payload.includedRecords,
    ...audioObjectKeysDeleted.map((key) => `audio_object:${key}`),
  ])];
  return {
    commit: async (tx) => commitPrivacyInTransaction({
      tx,
      actor: { tenantId: job.tenantId, userId: job.actorId },
      learnerId,
      kind,
      includedRecords,
      audioObjectKeysDeleted,
      traceId: job.payload.traceId,
    }),
  };
}

const privacyHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function createPrivacyJob(req, reply, ctx, kind) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;
  const learnerId = req.body?.learnerId;
  if (typeof learnerId !== "string") throw new RejectionError("learnerId is required", 422);

  // Authorization and existence remain before any externally visible work.
  requireSelfOrAny(actor, learnerId, ["admin", "ops"]);
  const traceId = req.headers["x-trace-id"] ?? null;
  const manifest = await capturePrivacyManifest(ctx, actor.tenantId, learnerId, kind);
  const inputVersion = privacyHash(manifest);
  const job = await ctx.jobStore.enqueue({
    tenantId: actor.tenantId,
    kind: `privacy.${kind}`,
    subjectId: learnerId,
    actorId: actor.userId,
    idempotencyKey: `privacy.${kind}:${actor.userId}:${learnerId}:${inputVersion}`,
    payload: {
      learnerId,
      inputVersion,
      includedRecords: manifest.includedRecords,
      audioObjectKeys: manifest.audioObjectKeys,
      traceId,
    },
  });
  const body = await waitForJobResult(ctx, job);

  return reply.send(body);
}

/** POST /v1/privacy/export — privacy.rs:67 */
export const createPrivacyExport = (req, reply, ctx) => createPrivacyJob(req, reply, ctx, "export");

/** POST /v1/privacy/delete — privacy.rs:76 */
export const createPrivacyDelete = (req, reply, ctx) => createPrivacyJob(req, reply, ctx, "delete");

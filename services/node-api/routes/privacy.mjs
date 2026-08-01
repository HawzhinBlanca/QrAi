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
 * 3. Erase the ML audio → 502 on failure, with the database UNTOUCHED. The DB rows are derived
 *    records; the raw audio is the sensitive PII, so it goes first.
 * 4. One tenant-scoped transaction for the whole cascade, so RLS isolates it AND the multi-table
 *    delete is atomic.
 *
 * Step 2 sits BEFORE step 3 deliberately. It reads like a detail and is not: with the ML service
 * unreachable, an unknown learner used to return 502 ("transient, retry me") instead of 404
 * ("permanent, do not"). Wrong-signal-for-retry is the defect that ordering exists to fix, so it
 * must not survive in the ML-outage case. A READ touches nothing, so "an ML outage fails fast with
 * the database untouched" still holds.
 */
import { randomUUID } from "node:crypto";

import { ApiError, NotFound, RejectionError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { proxy } from "../lib/proxy.mjs";

const newId = (prefix) => `${prefix}-${randomUUID()}`;

/**
 * Erase the learner's recorded audio from the ML inference service.
 *
 * The DB cascade only removes DERIVED records; the raw audio blobs live in the ML service's
 * storage, so without this call a "delete" leaves the recordings on disk. Idempotent, so the whole
 * delete is safe to retry.
 */
async function eraseMlAudio(ctx, tenantId, learnerId, traceId) {
  let response;
  try {
    response = await fetch(`${ctx.mlInferenceUrl}/v1/privacy/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ml-api-key": ctx.mlApiKey },
      body: JSON.stringify({ tenantId, learnerId, traceId }),
    });
  } catch (e) {
    console.error(`privacy delete: ML audio erase send error: ${e}`);
    throw new ApiError("audio erasure service unavailable", 502);
  }

  if (!response.ok) {
    console.warn(`privacy delete: ML audio erase upstream status ${response.status}`);
    throw new ApiError("audio erasure failed", 502);
  }

  let result;
  try {
    result = await response.json();
  } catch (e) {
    console.error(`privacy delete: ML audio erase parse error: ${e}`);
    throw new ApiError("audio erasure returned an invalid response", 502);
  }

  const keys = [];
  for (const field of ["deletedAudioObjectKeys", "deletedMetadataObjectKeys"]) {
    if (Array.isArray(result?.[field])) {
      keys.push(...result[field].filter((v) => typeof v === "string"));
    }
  }

  // A durable success-path record, emitted BEFORE the DB cascade runs. If a transient DB failure
  // then rolls back the privacy_jobs row, this line is the authoritative audit trail that the audio
  // was in fact deleted — without it a retry (which the ML service answers with an empty list, the
  // directory now gone) would leave no record that erasure ever happened.
  console.info(
    `privacy delete: erased ${keys.length} ML audio object(s) for tenant=${tenantId} ` +
      `learner=${learnerId} trace=${JSON.stringify(traceId)}`,
  );
  return keys;
}

async function createPrivacyJob(req, reply, ctx, kind) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  const learnerId = req.body?.learnerId;
  if (typeof learnerId !== "string") throw new RejectionError("learnerId is required", 422);

  // ── 1. Authorization FIRST. See the module comment; this is what makes the 404 below safe. ────
  requireSelfOrAny(actor, learnerId, ["admin", "ops"]);
  const traceId = req.headers["x-trace-id"] ?? null;

  // ── 2. Existence check, in its own short transaction, BEFORE the audio erase. ─────────────────
  const exists = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT 1 FROM users WHERE id = ${learnerId} AND tenant_id = ${actor.tenantId}`;
    return Boolean(row);
  });
  if (!exists) throw NotFound();

  // ── 3. Audio erase, before the DB cascade. An ML outage fails fast with the DB untouched. ─────
  const audioObjectKeysDeleted =
    kind === "delete" ? await eraseMlAudio(ctx, actor.tenantId, learnerId, traceId) : [];

  // ── 4. One tenant-scoped transaction: RLS isolates it AND the cascade is atomic. ──────────────
  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const sessions = await tx`
      SELECT id FROM recitation_sessions
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
    const progress = await tx`
      SELECT ayah_ref FROM learner_progress
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
    const agentRuns = await tx`
      SELECT id FROM agent_runs
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
    const pilotSessions = await tx`
      SELECT id FROM pilot_sessions
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;
    const pilotInvitations = await tx`
      SELECT id FROM pilot_invitations
      WHERE tenant_id = ${actor.tenantId} AND learner_id = ${learnerId}`;

    // The ORDER and the PREFIXES are wire contract — this list is what a learner receives as their
    // export manifest. Session ids are bare; everything else is namespaced.
    const includedRecords = [
      ...sessions.map((r) => r.id ?? ""),
      ...progress.map((r) => `learner_progress:${r.ayah_ref ?? ""}`),
      ...agentRuns.map((r) => `agent_run:${r.id ?? ""}`),
      ...pilotSessions.map((r) => `pilot_session:${r.id ?? ""}`),
      ...pilotInvitations.map((r) => `pilot_invitation:${r.id ?? ""}`),
    ];
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

    // `PrivacyJob` struct — DECLARATION order.
    return {
      id: jobId,
      tenantId: actor.tenantId,
      learnerId,
      kind,
      includedRecords,
      deletedRecords,
      audioObjectKeysDeleted,
      auditEventId: auditId,
    };
  });

  return reply.send(body);
}

/** POST /v1/privacy/export — privacy.rs:67 */
export const createPrivacyExport = (req, reply, ctx) => createPrivacyJob(req, reply, ctx, "export");

/** POST /v1/privacy/delete — privacy.rs:76 */
export const createPrivacyDelete = (req, reply, ctx) => createPrivacyJob(req, reply, ctx, "delete");

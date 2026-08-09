/**
 * Recitation sessions and realtime tickets. Port of
 * services/platform-api/src/handlers/recitation.rs.
 *
 * `POST /v1/realtime-session-tickets` was N5; N7 moved it here unchanged.
 *
 * Transcribed from handlers/recitation.rs:298-400 AFTER tests/api-parity/realtime-ticket.test.mjs
 * existed. The first attempt was written without that oracle and failed 7 of its 9 checks while
 * passing every pre-existing test in the repo — wrong role lists, consent from the wrong source,
 * no sample-rate negotiation, and neither of the two rows it must persist.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  ApiError,
  NotFound,
  RejectionError,
  Unauthorized,
  requireAnyRole,
  requireSelfOrAny,
  resolveActor,
} from "../lib/authz.mjs";
import { proxy } from "../lib/proxy.mjs";
import { issueRealtimeTicket, validateRealtimeTicket } from "../lib/ticket.mjs";
import {
  AudioIndexDomainError,
  indexAudioChunkRecord,
} from "../storage/audio-index.mjs";

/** services/platform-api/src/lib.rs:19 */
const REALTIME_TICKET_TTL_SECONDS = 300;

function usableSpan(startMs, endMs) {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return null;
  if (startMs < 0 || endMs <= startMs) return null;
  if (startMs > 2_147_483_647 || endMs > 2_147_483_647) return null;
  return { startMs, endMs };
}

/** POST /v1/audio-chunks — handlers/recitation.rs::index_audio_chunk. */
export async function indexAudioChunk(req, reply, ctx) {
  const ticket = req.headers["x-realtime-ticket"];
  if (typeof ticket !== "string" || ticket.trim() === "") throw Unauthorized();

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RejectionError("request body must be an object", 422);
  }
  const { sessionId, chunkId } = body;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new RejectionError("sessionId is required", 422);
  }
  if (typeof chunkId !== "string" || chunkId === "") {
    throw new RejectionError("chunkId is required", 422);
  }

  const claims = validateRealtimeTicket(
    sessionId,
    ticket,
    ctx.ticketSecret,
    Math.floor(Date.now() / 1000),
  );
  if (!claims) throw Unauthorized();

  const span = usableSpan(body.startMs, body.endMs);
  if (!span) {
    throw new ApiError("startMs/endMs must be integers with 0 <= startMs < endMs", 400);
  }
  const sampleRate = body.sampleRate == null ? 16_000 : body.sampleRate;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < -2_147_483_648 ||
    sampleRate > 2_147_483_647
  ) {
    throw new RejectionError("sampleRate must be an integer", 422);
  }

  try {
    await indexAudioChunkRecord({
      db: ctx.db,
      input: {
        tenantId: claims.tenantId,
        learnerId: claims.learnerId,
        sessionId: claims.sessionId,
        audioRetention: claims.audioRetention,
        chunkId,
        startMs: span.startMs,
        endMs: span.endMs,
        sampleRate,
      },
    });
  } catch (error) {
    if (!(error instanceof AudioIndexDomainError)) throw error;
    if (error.code === "session-not-found") throw NotFound();
    if (error.code === "authority-mismatch") throw Unauthorized();
    if (error.code === "immutable-conflict") {
      throw new ApiError("chunk id already indexes different immutable audio metadata", 409);
    }
    if (error.code === "invalid-object-key") {
      throw new ApiError("chunk identity cannot form a safe object key", 400);
    }
    throw error;
  }

  return reply.send({ chunkId, indexed: true, sessionId: claims.sessionId });
}

/** POST /v1/realtime-session-tickets — handlers/recitation.rs:298 */
export async function createRealtimeTicket(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // NOT the usual staff list: teacher and scholar are refused outright. A ticket is a live
  // audio credential, and reusing the read-route allowlist would hand one to every teacher.
  requireAnyRole(actor, ["learner", "admin", "ops"]);

  // 422, not 400: axum's `Json<T>` extractor rejects a body that fails to deserialize BEFORE
  // the handler runs, and serde's rejection is 422. The A/B against Rust caught this — the
  // status is what clients branch on, so it is matched.
  //
  // RECORDED DIVERGENCE, not fixed: Rust's body is serde's own text, e.g.
  //   "Failed to deserialize the JSON body into the target type: missing field `sessionId` at
  //    line 1 column 2"
  // Reproducing that byte-for-byte would mean reimplementing serde's error formatting, including
  // line/column offsets. It also leaks deserializer internals, so copying it is not obviously
  // desirable. Named in the N6 report rather than silently smoothed over.
  const sessionId = req.body?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new ApiError("sessionId is required", 422);
  }

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT s.id, s.tenant_id, s.learner_id, s.external_processing_allowed, c.audio_retention
      FROM recitation_sessions s
      JOIN consent_records c ON c.id = s.consent_record_id
      WHERE s.id = ${sessionId} AND s.tenant_id = ${actor.tenantId}`;
    if (!row) throw NotFound();

    requireSelfOrAny(actor, row.learner_id, ["admin", "ops"]);

    // The gateway trusts this flag to decide whether audio may leave for external ASR, so it
    // comes from the session's SERVER-SIDE column — never from the request, and never from the
    // consent snapshot JSON (which is the learner's stated preference, not the resolved gate).
    const externalAsr = row.external_processing_allowed === true;

    // The v1 realtime wire carries raw bytes with no codec/rate metadata. The Node audio runtime
    // can therefore describe exactly one truthful product profile: mono PCM16LE at 16 kHz.
    // Silently echoing 24/48 kHz here caused those bytes to be persisted and timed as 16 kHz.
    const allowedSampleRates = [16000];

    const auditId = `audit-${randomUUID()}`;
    const ticketId = `rt-ticket-${randomUUID()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + REALTIME_TICKET_TTL_SECONDS;
    const token = issueRealtimeTicket(
      {
        sessionId: row.id,
        tenantId: actor.tenantId,
        learnerId: row.learner_id,
        externalAsrProcessing: externalAsr,
        // Same rule as the flag above: the learner's STORED answer, joined from their consent
        // record. The gateway forwards it to the worker ingress, which is where the recording's lifetime
        // is actually decided.
        audioRetention: row.audio_retention,
        expiresAtUnixSeconds: expiresAt,
        nonce: randomUUID(),
      },
      ctx.ticketSecret,
    );

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId},
              'recitation.realtime-ticket.issued', 'realtime_session_ticket', ${ticketId},
              ${tx.json({ trace_id: req.headers["x-trace-id"] ?? null })})`;

    // Only the HASH is stored. Persisting the raw token would put a live credential in a table
    // that privacy exports and operator queries both read.
    await tx`
      INSERT INTO realtime_session_tickets
        (id, tenant_id, session_id, learner_id, token_hash, expires_at,
         allowed_sample_rates, external_asr_processing, audit_event_id)
      VALUES (${ticketId}, ${actor.tenantId}, ${row.id}, ${row.learner_id},
              ${createHash("sha256").update(token).digest("hex")},
              ${new Date(expiresAt * 1000)}, ${allowedSampleRates}, ${externalAsr}, ${auditId})`;

    return {
      sessionId: row.id,
      tenantId: actor.tenantId,
      learnerId: row.learner_id,
      // `expires_at.to_string()` on a u64 — a DECIMAL STRING of unix seconds. Serializing a Date
      // here would put RFC3339 on the wire and break every client that parses it as a number.
      expiresAt: String(expiresAt),
      allowedSampleRates,
      externalAsrProcessing: externalAsr,
      token,
      auditEventId: auditId,
    };
  });

  return reply.send(body);
}

/**
 * N14a — the four READ operations on recitation sessions.
 * Port of handlers/recitation.rs `get_session`, `list_sessions`, `list_active_learners`,
 * `list_session_alignments`.
 *
 * The three WRITES (create, persist-alignments, request-teacher-review) are N14b. They are ~440
 * lines carrying consent capture, an FK-skip policy and a provenance rule, and none of that belongs
 * in the same slice as four selects.
 */
import { ApiError, NotFound, requireAnyRole, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { f32, f64, sortKeysDeep } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";
import { fractional } from "./progress.mjs";

/** `#[serde(rename_all = "kebab-case")]` on PracticeMode; unknown falls back — recitation.rs:218. */
const PRACTICE_MODES = new Set([
  "listen",
  "guided-recite",
  "memory-recite",
  "correction",
  "drill",
  "complete",
]);

/** `parse_review_status` (recitation.rs:10) ERRORS on an unknown value rather than defaulting. */
const REVIEW_STATUSES = new Set([
  "draft",
  "ai-suggested",
  "teacher-review-required",
  "teacher-reviewed",
  "scholar-approved",
  "blocked",
]);

function requireKnownReviewStatus(value) {
  if (!REVIEW_STATUSES.has(value)) {
    throw new ApiError(`invalid review_status in database: ${value}`, 500);
  }
  return value;
}

/**
 * The MOST RESTRICTIVE consent, used when a session predates `consent_snapshot`.
 *
 * Never fabricate a consent the learner may not have given: every boolean is false and retention is
 * `discard`. A default of `anonymized-learning: true` here would silently opt historical learners
 * into training data.
 */
const RESTRICTIVE_CONSENT = {
  recordingConsent: false,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "unknown",
};

/** `QuranReference` fallback — recitation.rs:210. Declaration order, like the struct. */
const FALLBACK_QURAN_REF = {
  surahNumber: 1,
  ayahStart: 1,
  ayahEnd: 7,
  wordStart: null,
  wordEnd: null,
  display: "Unknown",
};

/**
 * Re-shape a stored `quran_ref` into the struct's DECLARATION order.
 *
 * `QuranReference` is a derive(Serialize) struct, so its field order is fixed regardless of how the
 * JSON was stored. `sortKeysDeep` would be wrong here — that reproduces a `serde_json::Value`
 * round trip, and this value is deserialized into a TYPED struct before it is written back out.
 */
function quranRef(stored) {
  if (!stored || typeof stored !== "object") return FALLBACK_QURAN_REF;
  const n = (v, fallback) => (typeof v === "number" ? v : fallback);
  return {
    surahNumber: n(stored.surahNumber, FALLBACK_QURAN_REF.surahNumber),
    ayahStart: n(stored.ayahStart, FALLBACK_QURAN_REF.ayahStart),
    ayahEnd: n(stored.ayahEnd, FALLBACK_QURAN_REF.ayahEnd),
    wordStart: typeof stored.wordStart === "number" ? stored.wordStart : null,
    wordEnd: typeof stored.wordEnd === "number" ? stored.wordEnd : null,
    display: typeof stored.display === "string" ? stored.display : FALLBACK_QURAN_REF.display,
  };
}

/** Same reasoning as `quranRef`: a typed struct, so declaration order, not stored order. */
function consent(stored) {
  if (!stored || typeof stored !== "object") return RESTRICTIVE_CONSENT;
  const b = (v, fallback) => (typeof v === "boolean" ? v : fallback);
  return {
    recordingConsent: b(stored.recordingConsent, false),
    audioRetention:
      typeof stored.audioRetention === "string" ? stored.audioRetention : "discard",
    anonymizedLearning: b(stored.anonymizedLearning, false),
    externalAsrProcessing: b(stored.externalAsrProcessing, false),
    guardianApproved: b(stored.guardianApproved, false),
    consentVersion:
      typeof stored.consentVersion === "string" ? stored.consentVersion : "unknown",
  };
}

/** GET /v1/recitation-sessions/{id} — recitation.rs:173 */
export async function getSession(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["learner", "teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT id, tenant_id, learner_id, quran_ref, source_checksum,
             model_version_id, mode, practice_plan_id,
             external_processing_allowed, confidence::float8 AS confidence, review_status,
             consent_snapshot, audit_event_id, language
      FROM recitation_sessions
      WHERE id = ${req.params.id} AND tenant_id = ${actor.tenantId}`;
    if (!row) throw NotFound();

    // The ownership check runs AFTER the row is found, so a learner asking for someone else's
    // session gets 403 and a learner asking for a session that does not exist gets 404 — the same
    // two answers Rust gives, in the same order.
    requireSelfOrAny(actor, row.learner_id, ["teacher", "admin", "ops"]);

    // `RecitationSession` is a derive(Serialize) STRUCT: DECLARATION order, not alphabetical.
    return {
      id: row.id,
      tenantId: row.tenant_id,
      learnerId: row.learner_id,
      quranRef: quranRef(row.quran_ref),
      sourceChecksum: row.source_checksum,
      modelVersion: row.model_version_id,
      language: row.language ?? "ar",
      mode: PRACTICE_MODES.has(row.mode) ? row.mode : "guided-recite",
      practicePlanId: row.practice_plan_id,
      externalProcessingAllowed: row.external_processing_allowed,
      // f32, not f64 — `RecitationSession.confidence` is f32 (types.rs:200).
      confidence: f32(Number(row.confidence ?? 0)),
      // `parse_review_status` ERRORS on an unknown value rather than defaulting — a corrupt
      // review_status is a 500, not a session that silently reads as `draft`. This gate decides
      // whether a learner sees AI feedback, so guessing at it is worse than failing.
      reviewStatus: requireKnownReviewStatus(row.review_status),
      consent: consent(row.consent_snapshot),
      auditEventId: row.audit_event_id ?? "",
    };
  });

  return reply.send(body);
}

/** GET /v1/recitation-sessions — recitation.rs:262 */
export async function listSessions(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Staff only. A learner cannot list a tenant's sessions even though they may read their own.
  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, learner_id, quran_ref, mode, confidence::float8 AS confidence, review_status,
             latency_ms,
             -- started_at.to_rfc3339(), formatted FROM THE COLUMN.
             --
             -- Not from a JS Date round trip: Date holds MILLISECONDS, so binding the driver's Date
             -- back into Postgres truncated .518326 to .518 and every timestamp on this route lost
             -- three digits. Caught by the A/B. It also removed 50 extra round trips, since the
             -- first version ran one formatting query per row.
             --
             -- (No backticks in this comment: it lives inside a JS template literal, and the first
             -- version of it terminated the SQL string mid-query.)
             to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS started_base,
             (EXTRACT(microseconds FROM started_at)::bigint % 1000000) AS started_us
      FROM recitation_sessions WHERE tenant_id = ${actor.tenantId}
      ORDER BY started_at DESC LIMIT 50`;

    return rows.map((r) => ({
      // json! keys, alphabetical.
      confidence: f64(Number(r.confidence ?? 0)),
      id: r.id ?? "",
      latencyMs: Number(r.latency_ms ?? 0),
      learnerId: r.learner_id ?? "",
      mode: r.mode ?? "",
      // Here the ref is passed through as a raw serde_json::Value — NOT deserialized into the
      // struct — so this one DOES get the BTreeMap key ordering. Same column, different rule,
      // because the two handlers treat it differently. Compare with `getSession` above.
      quranRef: sortKeysDeep(r.quran_ref ?? {}),
      reviewStatus: r.review_status ?? "",
      startedAt: `${r.started_base}${fractional(Number(r.started_us))}+00:00`,
    }));
  });

  return reply.send(body);
}

/**
 * GET /v1/learner/recitation-sessions — ADR-0038 / W2.8.
 *
 * This is intentionally separate from the tenant-wide staff list above. It is a compact practice
 * inbox, not a second feedback surface: counts communicate that review work exists, while every
 * judgement, confidence, explanation and source stays behind the per-session learner gate.
 */
export async function listLearnerSessionHistory(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["learner"]);

  const rawLimit = req.query?.limit;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit))
  ) {
    throw new ApiError("limit must be an integer between 1 and 50", 400);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ApiError("limit must be an integer between 1 and 50", 400);
  }

  const rawCursor = req.query?.cursor;
  if (rawCursor !== undefined && (typeof rawCursor !== "string" || rawCursor.length === 0)) {
    throw new ApiError("cursor must be a non-empty session id", 400);
  }
  const cursor = rawCursor ?? null;

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    if (cursor !== null) {
      const [ownedCursor] = await tx`
        SELECT 1
        FROM recitation_sessions
        WHERE id = ${cursor}
          AND tenant_id = ${actor.tenantId}
          AND learner_id = ${actor.userId}`;
      if (!ownedCursor) throw NotFound();
    }

    // Resolve the cursor inside Postgres rather than round-tripping started_at through a JS Date.
    // JS would discard the final three microsecond digits and could duplicate or skip a boundary
    // row. The id tie-breaker makes equal timestamps deterministic.
    const rows = await tx`
      SELECT s.id, s.quran_ref, s.mode, s.review_status,
             to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS started_base,
             (EXTRACT(microseconds FROM s.started_at)::bigint % 1000000) AS started_us,
             count(tf.id)::int AS finding_count,
             count(tf.id) FILTER (
               WHERE tf.review_status IN ('draft', 'ai-suggested', 'teacher-review-required')
             )::int AS pending_finding_count,
             count(tf.id) FILTER (
               WHERE tf.review_status IN ('teacher-reviewed', 'scholar-approved')
             )::int AS reviewed_finding_count,
             count(tf.id) FILTER (WHERE tf.review_status = 'blocked')::int AS blocked_finding_count
      FROM recitation_sessions s
      LEFT JOIN word_alignments wa
        ON wa.session_id = s.id AND wa.tenant_id = s.tenant_id
      LEFT JOIN tajweed_findings tf
        ON tf.alignment_id = wa.id
       AND tf.tenant_id = s.tenant_id
       AND tf.analysis_basis = 'acoustic'
      WHERE s.tenant_id = ${actor.tenantId}
        AND s.learner_id = ${actor.userId}
        AND (
          ${cursor === null}::boolean
          OR (s.started_at, s.id) < (
            SELECT c.started_at, c.id
            FROM recitation_sessions c
            WHERE c.id = ${cursor}
              AND c.tenant_id = ${actor.tenantId}
              AND c.learner_id = ${actor.userId}
          )
        )
      GROUP BY s.id
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${limit + 1}`;

    const page = rows.slice(0, limit).map((row) => ({
      id: row.id,
      quranRef: sortKeysDeep(row.quran_ref ?? {}),
      mode: row.mode ?? "",
      reviewStatus: requireKnownReviewStatus(row.review_status),
      startedAt: `${row.started_base}${fractional(Number(row.started_us))}+00:00`,
      findingCount: Number(row.finding_count),
      pendingFindingCount: Number(row.pending_finding_count),
      reviewedFindingCount: Number(row.reviewed_finding_count),
      blockedFindingCount: Number(row.blocked_finding_count),
    }));

    return {
      items: page,
      nextCursor: rows.length > limit ? page.at(-1).id : null,
    };
  });

  return reply.send(body);
}

/**
 * GET /v1/learners/active — recitation.rs:310
 *
 * The COMPLETE set of learner ids with at least one session, deliberately with NO limit:
 * `list_sessions` caps at 50 recent rows for the UI, so deriving "active learners" from it silently
 * drops learners once a tenant's volume exceeds the cap.
 */
export async function listActiveLearners(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT DISTINCT learner_id FROM recitation_sessions WHERE tenant_id = ${actor.tenantId}
      ORDER BY learner_id`;
    return rows.map((r) => r.learner_id);
  });

  return reply.send(body);
}

/** GET /v1/recitation-sessions/{id}/alignments — recitation.rs:438 */
export async function listSessionAlignments(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Staff only, and note there is NO ownership check and NO 404 for a missing session: an unknown
  // id returns an empty array. Transcribed, not improved — a 404 here would tell a caller which
  // session ids exist in the tenant.
  requireAnyRole(actor, ["teacher", "admin", "ops"]);

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const rows = await tx`
      SELECT wa.word_id, cw.text_uthmani, wa.heard_text, wa.start_ms, wa.end_ms,
             wa.confidence::float8 AS confidence, wa.status, wa.transcript_source,
             wa.model_version_id, wa.audit_event_id, ar.dataset_version, ar.model_attribution,
             COALESCE(ar.evidence_ids, '[]'::jsonb) AS evidence_ids
      FROM word_alignments wa
      JOIN canonical_words cw ON cw.id = wa.word_id
      LEFT JOIN alignment_runs ar
        ON ar.id = wa.alignment_run_id
       AND ar.tenant_id = wa.tenant_id
       AND ar.session_id = wa.session_id
      WHERE wa.session_id = ${req.params.id} AND wa.tenant_id = ${actor.tenantId}
      ORDER BY wa.start_ms ASC`;

    return rows.map((r) => ({
      // json! keys, alphabetical.
      auditEventId: r.audit_event_id ?? "",
      // `canonicalText` is canonical Quran text joined from canonical_words — verbatim, no trim,
      // no normalize, same rule as the /v1/quran routes.
      canonicalText: r.text_uthmani ?? "",
      confidence: f64(Number(r.confidence ?? 0)),
      datasetVersion: r.dataset_version ?? null,
      endMs: Number(r.end_ms ?? 0),
      evidenceIds: Array.isArray(r.evidence_ids) ? r.evidence_ids : [],
      heardText: r.heard_text ?? "",
      modelAttribution: r.model_attribution ?? null,
      modelVersion: r.model_version_id ?? "",
      startMs: Number(r.start_ms ?? 0),
      status: r.status ?? "",
      transcriptSource: r.transcript_source ?? "client-reported",
      wordId: r.word_id ?? "",
    }));
  });

  return reply.send(body);
}

/**
 * N14b — the three WRITE operations on recitation sessions.
 * Port of handlers/recitation.rs `create_session`, `persist_session_alignments`,
 * `request_teacher_review`.
 *
 * These carry the policies the reads only display: consent capture, a foreign-key ordering that is
 * the difference between a fix and an enumeration oracle, a provenance rule, and a cascade that
 * destroys review history.
 */
import { randomUUID } from "node:crypto";

import { ApiError, Forbidden, NotFound, RejectionError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { f32 } from "../lib/json.mjs";
import { proxy } from "../lib/proxy.mjs";

/** types.rs:9 — mirrors packages/contracts SUPPORTED_LANGUAGE_CODES exactly. */
const SUPPORTED_LANGUAGES = ["ar", "ckb", "en", "tr", "ur", "id", "ms", "fr", "de"];

const PRACTICE_MODES = ["listen", "guided-recite", "memory-recite", "correction", "drill", "complete"];
const VALID_ALIGNMENT_STATUS = ["matched", "misread", "missed", "extra", "needs-review"];
const AUDIO_RETENTIONS = ["discard", "training-opt-in", "teacher-review"];

const newId = (prefix) => `${prefix}-${randomUUID()}`;

/** `extract_trace_id` — the header the audit metadata carries. */
const traceId = (req) => req.headers["x-trace-id"] ?? null;

/**
 * Apply the request struct's serde defaults to a consent object.
 *
 * `Consent` has `#[serde(default)]` on three booleans and a default fn for `consent_version`, but
 * `audio_retention` and `anonymized_learning` are REQUIRED — a body missing either is a 422 from
 * the extractor, not a consent record with an invented retention policy.
 */
/**
 * The time span an alignment claims, or `null` if it does not identify any audio.
 *
 * A faithful mirror of `usable_span` in handlers/recitation.rs — the same three conditions, in the
 * same order, so a payload refused there is refused here.
 *
 * `start_ms`/`end_ms` are the ONLY record of where in a recitation a word was heard, and a tajweed
 * finding is anchored to the alignment row. A finding whose span is 0ms-to-0ms points at nothing: a
 * reviewer asked to adjudicate it has nothing to listen to, and the row is indistinguishable in the
 * table from one pointing at real audio. Measured in staging before this existed: 2686 findings, of
 * which 507 (19%) resolved to a zero-length span.
 *
 * `Number.isInteger` is the mirror of serde_json's `as_i64`, which likewise reports nothing for a
 * string, a bool, null, or a float with a fractional part. The previous code here was
 * `Number.isInteger(a.startMs) ? a.startMs : 0` — it asked the right question and then answered a
 * different one, turning every unusable timing into the integer 0.
 */
function usableSpan(startMs, endMs) {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return null;
  if (startMs < 0 || endMs <= startMs) return null;
  // int4, matching the column and Rust's i32::try_from.
  if (startMs > 2147483647 || endMs > 2147483647) return null;
  return { startMs, endMs };
}

function consentFrom(raw) {
  if (!raw || typeof raw !== "object") throw new RejectionError("consent is required", 422);
  if (!AUDIO_RETENTIONS.includes(raw.audioRetention)) {
    throw new RejectionError("consent.audioRetention is required", 422);
  }
  if (typeof raw.anonymizedLearning !== "boolean") {
    throw new RejectionError("consent.anonymizedLearning is required", 422);
  }
  return {
    recordingConsent: raw.recordingConsent === true,
    audioRetention: raw.audioRetention,
    anonymizedLearning: raw.anonymizedLearning,
    externalAsrProcessing: raw.externalAsrProcessing === true,
    guardianApproved: raw.guardianApproved === true,
    consentVersion: typeof raw.consentVersion === "string" ? raw.consentVersion : "pilot-v1",
  };
}

/** `QuranReference` — every field required except the two optional word bounds. */
function quranRefFrom(raw) {
  if (!raw || typeof raw !== "object") throw new RejectionError("quranRef is required", 422);
  for (const k of ["surahNumber", "ayahStart", "ayahEnd"]) {
    if (typeof raw[k] !== "number") throw new RejectionError(`quranRef.${k} is required`, 422);
  }
  if (typeof raw.display !== "string") throw new RejectionError("quranRef.display is required", 422);
  return {
    surahNumber: raw.surahNumber,
    ayahStart: raw.ayahStart,
    ayahEnd: raw.ayahEnd,
    wordStart: typeof raw.wordStart === "number" ? raw.wordStart : null,
    wordEnd: typeof raw.wordEnd === "number" ? raw.wordEnd : null,
    display: raw.display,
  };
}

/** POST /v1/recitation-sessions — recitation.rs:24 */
export async function createSession(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  const b = req.body ?? {};
  if (typeof b.learnerId !== "string") throw new RejectionError("learnerId is required", 422);
  if (typeof b.sourceChecksum !== "string") throw new RejectionError("sourceChecksum is required", 422);
  if (Object.hasOwn(b, "modelVersion") || Object.hasOwn(b, "modelAttribution")) {
    throw new ApiError("model identity is server-selected and must not be supplied", 400);
  }
  if (typeof b.language !== "string") throw new RejectionError("language is required", 422);

  // NOT the usual staff list: teacher is absent. Only admin/ops may open a session on behalf of
  // another learner; a teacher cannot.
  requireSelfOrAny(actor, b.learnerId, ["admin", "ops"]);

  if (!SUPPORTED_LANGUAGES.includes(b.language)) {
    // Rust's `{SUPPORTED_LANGUAGE_CODES:?}` debug-formats a slice as `["ar", "ckb", …]` — with a
    // SPACE after each comma. `JSON.stringify` emits none. Error messages are wire contract in this
    // repo (the fixture differ fails on a changed one), so the separator is reproduced rather than
    // approximated.
    const allowed = `[${SUPPORTED_LANGUAGES.map((c) => `"${c}"`).join(", ")}]`;
    throw new ApiError(
      `unsupported language ${JSON.stringify(b.language)}; allowed: ${allowed}`,
      400,
    );
  }

  const quranRef = quranRefFrom(b.quranRef);
  const consent = consentFrom(b.consent);
  const mode = PRACTICE_MODES.includes(b.mode) ? b.mode : "guided-recite";
  const practicePlanId = typeof b.practicePlanId === "string" ? b.practicePlanId : "fatihah-mastery-v1";

  // BOTH must hold. Consent to external ASR without guardian approval does not permit it.
  const externalProcessingAllowed = consent.externalAsrProcessing && consent.guardianApproved;

  const sessionId = newId("session");
  const auditId = newId("audit");

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    // FK2 — AFTER require_self_or_any, and it MUST stay there. Put the existence check first and a
    // learner can enumerate learner ids by reading 404-vs-403. Tenant-scoped for the same reason.
    const [learner] = await tx`
      SELECT 1 FROM users WHERE id = ${b.learnerId} AND tenant_id = ${actor.tenantId}`;
    if (!learner) throw NotFound();

    // Server-selected provenance. Exactly one alignment implementation may be active in this
    // transitional registry; zero or multiple rows is a deployment fault, never a reason to guess.
    const models = await tx`
      SELECT id FROM model_versions
      WHERE kind = 'alignment' AND runtime_selected
      ORDER BY id`;
    if (models.length !== 1) {
      throw new ApiError("server model configuration unavailable", 503);
    }
    const modelVersion = models[0].id;

    // Audit FIRST: recitation_sessions.audit_event_id FK-references this row.
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'recitation.session.started',
              'recitation_session', ${sessionId},
              ${tx.json({ trace_id: traceId(req), model_version: modelVersion })})`;

    const consentRecordId = newId("consent");
    await tx`
      INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
      VALUES (${consentRecordId}, ${actor.tenantId}, ${b.learnerId}, ${consent.audioRetention},
              ${consent.anonymizedLearning}, ${consent.externalAsrProcessing},
              ${consent.guardianApproved}, ${consent.consentVersion}, ${auditId})`;

    await tx`
      INSERT INTO recitation_sessions
        (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id,
         mode, practice_plan_id, external_processing_allowed, confidence, review_status,
         started_at, latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
      VALUES (${sessionId}, ${actor.tenantId}, ${b.learnerId}, ${tx.json(quranRef)},
              ${b.sourceChecksum}, ${modelVersion}, ${mode}, ${practicePlanId},
              ${externalProcessingAllowed}, 0.0, 'draft', now(), 0, ${consentRecordId},
              ${tx.json(consent)}, ${auditId}, ${b.language})`;

    // `RecitationSession` struct — declaration order. Model identity is the server selection above;
    // the remaining values come from the validated request and stored consent snapshot.
    return {
      id: sessionId,
      tenantId: actor.tenantId,
      learnerId: b.learnerId,
      quranRef,
      sourceChecksum: b.sourceChecksum,
      modelVersion,
      language: b.language,
      mode,
      practicePlanId,
      externalProcessingAllowed,
      confidence: f32(0),
      reviewStatus: "draft",
      consent,
      auditEventId: auditId,
    };
  });

  return reply.send(body);
}

/** POST /v1/recitation-sessions/{id}/alignments — recitation.rs:512 */
export async function persistSessionAlignments(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  const sessionId = req.params.id;
  const alignments = req.body?.alignments;
  if (!Array.isArray(alignments)) throw new RejectionError("alignments is required", 422);
  if (Object.hasOwn(req.body ?? {}, "modelVersion") || Object.hasOwn(req.body ?? {}, "modelAttribution")) {
    throw new ApiError("model identity is server-selected and must not be supplied", 400);
  }

  const auditId = newId("audit");

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT learner_id, model_version_id FROM recitation_sessions
      WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
    if (!session) throw NotFound();
    requireSelfOrAny(actor, session.learner_id, ["teacher", "admin", "ops"]);

    // Alignment rows inherit the server-selected identity stored on their session. A caller
    // cannot replace it and there is no independent fallback to drift from the session record.
    const modelVersion = session.model_version_id;

    // Replace-on-write, in FK-SAFE ORDER. tajweed_findings.alignment_id and
    // teacher_reviews.finding_id both RESTRICT, so a naked DELETE of word_alignments raises a
    // foreign_key_violation (→ 500) for any session that already has findings or reviews.
    // DETACHED, not deleted (0024_teacher_review_survives_realignment.sql). This route is reached by
    // the session OWNER, so the DELETE this replaced let a learner re-recording their own session
    // erase a review a teacher had already submitted. Nulling finding_id releases the RESTRICT so the
    // finding can go, while the review row, its author, note, decision and snapshot survive — marked
    // as being about something the learner has since replaced. Mirrors recitation.rs.
    const deletedTeacherReviews = (
      await tx`
        UPDATE teacher_reviews SET finding_id = NULL, superseded_at = now()
        WHERE tenant_id = ${actor.tenantId} AND superseded_at IS NULL AND finding_id IN (
          SELECT tf.id FROM tajweed_findings tf
          JOIN word_alignments wa ON wa.id = tf.alignment_id
          WHERE wa.session_id = ${sessionId} AND wa.tenant_id = ${actor.tenantId})`
    ).count;

    const deletedTajweedFindings = (
      await tx`
        DELETE FROM tajweed_findings WHERE tenant_id = ${actor.tenantId} AND alignment_id IN (
          SELECT id FROM word_alignments
          WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId})`
    ).count;

    await tx`
      DELETE FROM word_alignments
      WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId}`;

    // A client re-record replaces the words and therefore invalidates any server-derived run that
    // described the prior recording. The explicit word->run link prevents misattribution already;
    // deleting the orphan keeps retention/export state truthful and mirrors Rust.
    const deletedAlignmentRuns = (
      await tx`
        DELETE FROM alignment_runs
        WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId}`
    ).count;

    // Audit AFTER the cascade, recording what this request ACTUALLY did. `deletedTeacherReviews`
    // keeps its name now that the reviews are detached rather than destroyed: the number still
    // answers what it was added to answer — how much review history this request affected — and
    // renaming an audit-log field breaks every existing reader for a wording improvement.
    // Ordered before the INSERTs, which reference it.
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'recitation.alignment.persisted',
              'recitation_session', ${sessionId},
              ${tx.json({
                trace_id: traceId(req),
                count: alignments.length,
                deletedAlignmentRuns,
                deletedTeacherReviews,
                deletedTajweedFindings,
                modelVersion,
                transcriptSource: "client-reported",
              })})`;

    // Partition once. An UNRECOGNISED status is a data-quality signal from the ML service (a typo
    // like "matche"), not something to drop silently — count it, log it, report it.
    const valid = alignments.filter((a) => VALID_ALIGNMENT_STATUS.includes(a?.status));
    const invalidStatus = alignments.filter((a) => !VALID_ALIGNMENT_STATUS.includes(a?.status));

    // ONE query, not one per alignment. canonical_words is global reference data.
    const candidateIds = valid.map((a) => a.wordId);
    const knownRows =
      candidateIds.length > 0
        ? await tx`SELECT id FROM canonical_words WHERE id = ANY(${candidateIds})`
        : [];
    const knownWords = new Set(knownRows.map((r) => r.id));

    let persisted = 0;
    let skippedUnknownWord = 0;
    let skippedUnusableSpan = 0;
    for (const a of valid) {
      // Only real canonical words satisfy the word_id FK. Synthetic ids ("extra-N") are EXPECTED to
      // be absent — an "extra" word the learner said that is not in the canonical text.
      if (!knownWords.has(a.wordId)) {
        skippedUnknownWord += 1;
        continue;
      }
      // Mirrors `usable_span` in recitation.rs. Skipped and COUNTED like an unknown word, so one bad
      // timing does not discard the rest of the batch.
      const span = usableSpan(a.startMs, a.endMs);
      if (span === null) {
        skippedUnusableSpan += 1;
        continue;
      }
      await tx`
        INSERT INTO word_alignments
          (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
           model_version_id, audit_event_id, transcript_source)
        VALUES (${newId("word-alignment")}, ${actor.tenantId}, ${sessionId}, ${a.wordId},
                ${typeof a.heardText === "string" ? a.heardText : ""},
                ${span.startMs},
                ${span.endMs},
                ${Math.min(Math.max(Number(a.confidence) || 0, 0), 1)}::float8::numeric,
                ${a.status}, ${modelVersion}, ${auditId}, 'client-reported')`;
      persisted += 1;
    }

    if (invalidStatus.length > 0) {
      // The offending strings, not just a count, so an ML data-quality problem is greppable without
      // reproducing against the database.
      console.warn(
        `persist_session_alignments session=${sessionId}: ${invalidStatus.length} alignment(s) had ` +
          `an unrecognised status and were skipped (ML data-quality issue): ` +
          JSON.stringify(invalidStatus.map((a) => a?.status)),
      );
    }

    // json! keys, alphabetical.
    return {
      auditEventId: auditId,
      persisted,
      sessionId,
      skippedInvalidStatus: invalidStatus.length,
      skippedUnknownWord,
      skippedUnusableSpan,
      // Hardcoded, matching the Rust original: this route's words come from whatever the caller
      // sent, so it can only ever mint `client-reported`. `server-derived` belongs to
      // finalize_session, which is not ported (Phase 7) and takes no words from a caller at all.
      transcriptSource: "client-reported",
    };
  });

  return reply.send(body);
}

/**
 * POST /v1/recitation-sessions/{id}/request-teacher-review — recitation.rs:703
 *
 * Owner-only, and there is NO staff override: a teacher cannot send a learner's session on the
 * learner's behalf. Idempotent, so a double-tap never errors. Draft-only otherwise, so a session a
 * teacher or scholar has already progressed is not silently reset by a learner action.
 */
export async function requestTeacherReview(req, reply, ctx) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  const sessionId = req.params.id;
  const auditId = newId("audit");

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT learner_id, review_status FROM recitation_sessions
      WHERE tenant_id = ${actor.tenantId} AND id = ${sessionId}`;
    if (!row) throw NotFound();

    // Owner-only. `requireSelfOrAny` with an empty allowlist would also work, but the Rust is a
    // bare comparison and this keeps the two readable side by side.
    if (row.learner_id !== actor.userId) throw Forbidden("only the session owner may send it");

    if (row.review_status === "teacher-review-required") {
      // Idempotent 200, and note it carries `alreadyRequested` instead of `auditEventId`: no audit
      // row is written because nothing happened.
      return { alreadyRequested: true, reviewStatus: "teacher-review-required", sessionId };
    }
    if (row.review_status !== "draft") {
      throw new ApiError(
        `session review_status is '${row.review_status}'; only a draft session can be sent for ` +
          "teacher review",
        400,
      );
    }

    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'session.teacher_review.requested',
              'recitation_session', ${sessionId})`;

    await tx`
      UPDATE recitation_sessions SET review_status = 'teacher-review-required'
      WHERE tenant_id = ${actor.tenantId} AND id = ${sessionId}`;

    return { auditEventId: auditId, reviewStatus: "teacher-review-required", sessionId };
  });

  return reply.send(body);
}

/**
 * N14b/W2.6 — the four WRITE operations on recitation sessions.
 * Port of handlers/recitation.rs `create_session`, `persist_session_alignments`,
 * `finalize_session`, and `request_teacher_review`.
 *
 * These carry the policies the reads only display: consent capture, a foreign-key ordering that is
 * the difference between a fix and an enumeration oracle, a provenance rule, and a cascade that
 * destroys review history.
 */
import { createHash, randomUUID } from "node:crypto";

import { waitForJobResult } from "../jobs/wait-for-job.mjs";
import { ApiError, Forbidden, NotFound, RejectionError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { createDeadline } from "../lib/deadline.mjs";
import { f32 } from "../lib/json.mjs";
import {
  requireExactAttributionExtension,
  requireProducerAttribution,
} from "../lib/model-attribution.mjs";
import { proxy } from "../lib/proxy.mjs";
import {
  recoveryReportFromSessionRow,
  recoveryReportsEqual,
  recoveryResponseFields,
  validateRecoveryReportBody,
} from "../realtime/recovery-report.mjs";

/** types.rs:9 — mirrors packages/contracts SUPPORTED_LANGUAGE_CODES exactly. */
const SUPPORTED_LANGUAGES = ["ar", "ckb", "en", "tr", "ur", "id", "ms", "fr", "de"];

const PRACTICE_MODES = ["listen", "guided-recite", "memory-recite", "correction", "drill", "complete"];
const VALID_ALIGNMENT_STATUS = ["matched", "misread", "missed", "extra", "needs-review"];
const AUDIO_RETENTIONS = ["discard", "training-opt-in", "teacher-review"];

const newId = (prefix) => `${prefix}-${randomUUID()}`;

/** `extract_trace_id` — the header the audit metadata carries. */
const traceId = (req) => {
  const raw = req.headers["x-trace-id"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

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

/**
 * The one destructive alignment writer. The public practice route and server finalizer both call
 * this inside an already tenant-scoped transaction; neither may copy its cascade or insert path.
 */
export async function persistAlignmentsInTransaction({
  tx,
  actor,
  sessionId,
  alignments,
  transcriptSource,
  provenance = null,
  requestTrace = null,
}) {
  const [session] = await tx`
    SELECT model_version_id FROM recitation_sessions
    WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
  if (!session) throw NotFound();

  // Alignment rows inherit the server-selected identity stored on their session. A caller cannot
  // replace it and there is no independent fallback to drift from the session record.
  const modelVersion = session.model_version_id;
  if (
    !["client-reported", "server-derived"].includes(transcriptSource) ||
    (transcriptSource === "server-derived") !== (provenance !== null)
  ) {
    console.error("alignment persistence source and run provenance disagree");
    throw new ApiError("ML service returned invalid model provenance", 502);
  }
  if (provenance !== null && provenance.modelVersion !== modelVersion) {
    console.error("alignment run model disagrees with session model");
    throw new ApiError("ML service returned invalid model provenance", 502);
  }

  const auditId = newId("audit");

  // Replace-on-write, in FK-SAFE ORDER. Reviews are detached, not deleted, so a learner action
  // cannot erase a teacher's authored judgement; findings and words tied to the replaced recording
  // are then removed.
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

  const deletedAlignmentRuns = (
    await tx`
      DELETE FROM alignment_runs
      WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId}`
  ).count;

  // Audit after the cascade and before dependent inserts. The historical metadata key stays named
  // `deletedTeacherReviews` even though the rows are now detached; existing audit readers depend on
  // it and the value still measures how much review history was affected.
  await tx`
    INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
    VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'recitation.alignment.persisted',
            'recitation_session', ${sessionId},
            ${tx.json({
              trace_id: requestTrace,
              count: alignments.length,
              deletedAlignmentRuns,
              deletedTeacherReviews,
              deletedTajweedFindings,
              modelVersion,
              transcriptSource,
            })})`;

  let alignmentRunId = null;
  if (provenance !== null) {
    alignmentRunId = newId("alignment-run");
    await tx`
      INSERT INTO alignment_runs
        (id, tenant_id, session_id, model_version_id, dataset_version, latency_ms,
         evidence_ids, consent_snapshot, audit_event_id, transcript_source, model_attribution)
      VALUES (${alignmentRunId}, ${actor.tenantId}, ${sessionId}, ${modelVersion},
              ${provenance.datasetVersion}, ${provenance.latencyMs},
              ${tx.json(provenance.evidenceIds)}, ${tx.json(provenance.consentSnapshot)},
              ${auditId}, ${transcriptSource}, ${tx.json(provenance.modelAttribution)})`;
  }

  const valid = alignments.filter((a) => VALID_ALIGNMENT_STATUS.includes(a?.status));
  const invalidStatus = alignments.filter((a) => !VALID_ALIGNMENT_STATUS.includes(a?.status));

  // One canonical lookup, not one query per word. This global reference table is intentionally not
  // tenant-scoped; its immutable rows are the FK authority.
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
    if (!knownWords.has(a.wordId)) {
      skippedUnknownWord += 1;
      continue;
    }
    const span = usableSpan(a.startMs, a.endMs);
    if (span === null) {
      skippedUnusableSpan += 1;
      continue;
    }
    await tx`
      INSERT INTO word_alignments
        (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
         model_version_id, audit_event_id, transcript_source, alignment_run_id)
      VALUES (${newId("word-alignment")}, ${actor.tenantId}, ${sessionId}, ${a.wordId},
              ${typeof a.heardText === "string" ? a.heardText : ""}, ${span.startMs},
              ${span.endMs},
              ${Math.min(Math.max(Number(a.confidence) || 0, 0), 1)}::float8::numeric,
              ${a.status}, ${modelVersion}, ${auditId}, ${transcriptSource}, ${alignmentRunId})`;
    persisted += 1;
  }

  if (invalidStatus.length > 0) {
    console.warn(
      `persist_session_alignments session=${sessionId}: ${invalidStatus.length} alignment(s) had ` +
        `an unrecognised status and were skipped (ML data-quality issue): ` +
        JSON.stringify(invalidStatus.map((a) => a?.status)),
    );
  }

  return {
    auditEventId: auditId,
    persisted,
    sessionId,
    skippedInvalidStatus: invalidStatus.length,
    skippedUnknownWord,
    skippedUnusableSpan,
    transcriptSource,
  };
}

/** POST /v1/recitation-sessions/{id}/alignments — recitation.rs:995 */
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

  const body = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT learner_id FROM recitation_sessions
      WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
    if (!session) throw NotFound();
    requireSelfOrAny(actor, session.learner_id, ["teacher", "admin", "ops"]);
    return persistAlignmentsInTransaction({
      tx,
      actor,
      sessionId,
      alignments,
      transcriptSource: "client-reported",
      requestTrace: traceId(req),
    });
  });

  return reply.send(body);
}

const refusal = (sessionId, reason) => ({
  finalized: false,
  persisted: 0,
  reason,
  sessionId,
});

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

const snapshotHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function authorizeFinalization(ctx, actor, sessionId, requestedRecoveryReport) {
  return ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [session] = await tx`
      SELECT learner_id, model_version_id, consent_record_id,
             capture_report_version, capture_report_state, capture_total_chunks,
             capture_acknowledged_chunks, capture_dropped_chunks,
             capture_uncertain_chunks, capture_stop_reason
      FROM recitation_sessions
      WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}
      FOR UPDATE`;
    if (!session) throw NotFound();
    requireSelfOrAny(actor, session.learner_id, ["teacher", "admin", "ops"]);

    let storedRecoveryReport = recoveryReportFromSessionRow(session);
    if (requestedRecoveryReport !== null) {
      // This is client-capture truth, not staff review authority. Staff may still run legacy
      // finalization, but only the owning learner may create or retry a recovery report.
      requireSelfOrAny(actor, session.learner_id, []);
      if (
        storedRecoveryReport !== null &&
        !recoveryReportsEqual(storedRecoveryReport, requestedRecoveryReport)
      ) {
        throw new ApiError("recovery report conflicts with the first accepted report", 409);
      }
      if (storedRecoveryReport === null) {
        await tx`
          UPDATE recitation_sessions
          SET capture_report_version = ${requestedRecoveryReport.version},
              capture_report_state = ${requestedRecoveryReport.state},
              capture_total_chunks = ${requestedRecoveryReport.capturedChunks},
              capture_acknowledged_chunks = ${requestedRecoveryReport.acknowledgedChunks},
              capture_dropped_chunks = ${requestedRecoveryReport.droppedChunks},
              capture_uncertain_chunks = ${requestedRecoveryReport.uncertainChunks},
              capture_stop_reason = ${requestedRecoveryReport.stopReason},
              capture_reported_at = clock_timestamp()
          WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
        storedRecoveryReport = requestedRecoveryReport;
      }
    }

    // Include the current evidence state. Concurrent identical calls deduplicate, while an explicit
    // later re-finalization after alignments changed remains a new immutable input generation.
    const chunks = await tx`
      SELECT id, evidence_id, start_ms, end_ms, sample_rate, status, object_key
      FROM audio_chunks
      WHERE tenant_id = ${actor.tenantId} AND session_id = ${sessionId}
      ORDER BY id`;
    const alignments = await tx`
      SELECT id, word_id, start_ms, end_ms, status, transcript_source, alignment_run_id
      FROM word_alignments
      WHERE tenant_id = ${actor.tenantId} AND session_id = ${sessionId}
      ORDER BY id`;
    return snapshotHash({
      session: {
        consentRecordId: session.consent_record_id,
        modelVersionId: session.model_version_id,
      },
      recoveryReport: storedRecoveryReport,
      chunks,
      alignments,
    });
  });
}

async function currentServerLostChunkCount(tx, tenantId, sessionId) {
  const [row] = await tx`
    SELECT lost_chunk_count
    FROM recitation_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}`;
  if (!row) throw NotFound();
  return Number(row.lost_chunk_count);
}

const completedWithoutEffect = ({ response, recoveryReport, tenantId, sessionId }) => ({
  result: {},
  commit: async (tx) => {
    const serverLostChunkCount = await currentServerLostChunkCount(tx, tenantId, sessionId);
    return {
      response: {
        ...response,
        ...recoveryResponseFields(recoveryReport, serverLostChunkCount),
      },
    };
  },
});

/** Prepare repeatable external finalization work; the returned commit owns every DB effect. */
export async function prepareSessionFinalization({
  ctx,
  tenantId,
  actorId,
  sessionId,
  requestTrace = null,
  signal,
}) {
  const actor = { tenantId, userId: actorId };
  const deadline = createDeadline(ctx.upstreamTimeoutMs, { parentSignal: signal });

  // Release the DB connection before the two inference round-trips. A slow ASR call must not hold a
  // tenant transaction and exhaust the pool for unrelated learners.
  const session = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx`
      SELECT s.learner_id, s.quran_ref, s.model_version_id, s.consent_snapshot,
             s.capture_report_version, s.capture_report_state, s.capture_total_chunks,
             s.capture_acknowledged_chunks, s.capture_dropped_chunks,
             s.capture_uncertain_chunks, s.capture_stop_reason,
             c.guardian_approved, c.external_asr_processing
      FROM recitation_sessions s
      JOIN consent_records c ON c.id = s.consent_record_id
      WHERE s.id = ${sessionId} AND s.tenant_id = ${actor.tenantId}`;
    if (!row) throw NotFound();
    return row;
  });
  const recoveryReport = recoveryReportFromSessionRow(session);

  const consent = {
    externalAsrProcessing: session.external_asr_processing,
    guardianApproved: session.guardian_approved,
  };
  const transcript = await ctx.inference.transcribeSession({
    consent,
    learnerId: session.learner_id,
    sessionId,
    tenantId: actor.tenantId,
  }, deadline);

  if (transcript?.transcribed !== true) {
    return completedWithoutEffect({
      response: refusal(
        sessionId,
        typeof transcript?.reason === "string" ? transcript.reason : "unknown",
      ),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }
  if (transcript?.transcriptSource !== "server-derived") {
    console.error("ML transcript omitted its server-derived source label");
    throw new ApiError("ML service returned invalid model provenance", 502);
  }
  requireProducerAttribution(transcript, "asr", "ML");

  const recognizedTokens = transcript?.recognizedTokens;
  if (!Array.isArray(recognizedTokens) || recognizedTokens.length === 0) {
    return completedWithoutEffect({
      response: refusal(sessionId, "invalid-recognized-spans"),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }

  const alignment = await ctx.inference.predictAlignment({
    consent,
    quranRef: session.quran_ref,
    recognizedTokens,
    sessionId,
    tenantId: actor.tenantId,
    transcriptModelAttribution: transcript.modelAttribution,
  }, deadline);

  if (alignment?.finalizable !== true) {
    return completedWithoutEffect({
      response: refusal(
        sessionId,
        typeof alignment?.nonFinalizedReason === "string"
          ? alignment.nonFinalizedReason
          : "invalid-recognized-spans",
      ),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }
  requireProducerAttribution(alignment, "quran-aligner", "ML");
  requireExactAttributionExtension(transcript, alignment, "quran-aligner", "ML");

  if (alignment.modelVersion !== session.model_version_id) {
    console.warn("finalization refused because the session and producer models disagree");
    return completedWithoutEffect({
      response: refusal(sessionId, "model-version-mismatch"),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }
  if (
    !nonEmptyString(alignment.datasetVersion) ||
    !nonEmptyString(alignment.evidenceId) ||
    !Number.isInteger(alignment.latencyMs) ||
    alignment.latencyMs <= 0 ||
    alignment.latencyMs > 2_147_483_647
  ) {
    throw new ApiError("ML service returned invalid model provenance", 502);
  }

  let invalidOutput = !Array.isArray(alignment.alignments);
  const alignments = [];
  if (!invalidOutput) {
    for (const row of alignment.alignments) {
      const status = row?.status;
      if (typeof status !== "string") {
        invalidOutput = true;
        break;
      }
      if (status === "matched" || status === "misread") {
        if (typeof row.wordId !== "string" || typeof row.heardText !== "string") {
          invalidOutput = true;
          break;
        }
        alignments.push({
          confidence: typeof row.confidence === "number" ? row.confidence : 0,
          endMs: row.endMs ?? null,
          heardText: row.heardText,
          startMs: row.startMs ?? null,
          status,
          wordId: row.wordId,
        });
      } else if (!["missed", "extra", "needs-review"].includes(status)) {
        invalidOutput = true;
        break;
      }
    }
  }
  if (invalidOutput || alignments.length === 0) {
    return completedWithoutEffect({
      response: refusal(
        sessionId,
        invalidOutput ? "invalid-alignment-output" : "no-persistable-alignments",
      ),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }

  // Preflight every destructive-writer condition before the fenced transaction. Canonical word
  // membership is immutable, so this cannot become stale between preparation and commit. Refusing
  // here preserves prior practice rows without needing to commit then roll back a job completion.
  const persistable = await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const candidateIds = alignments.map((row) => row.wordId);
    const knownRows = await tx`SELECT id FROM canonical_words WHERE id = ANY(${candidateIds})`;
    const known = new Set(knownRows.map((row) => row.id));
    return alignments.every(
      (row) => known.has(row.wordId) && usableSpan(row.startMs, row.endMs) !== null,
    );
  });
  if (!persistable) {
    return completedWithoutEffect({
      response: refusal(sessionId, "invalid-alignment-output"),
      recoveryReport,
      tenantId: actor.tenantId,
      sessionId,
    });
  }

  const provenance = {
    consentSnapshot: session.consent_snapshot,
    datasetVersion: alignment.datasetVersion,
    evidenceIds: [alignment.evidenceId],
    latencyMs: alignment.latencyMs,
    modelAttribution: alignment.modelAttribution,
    modelVersion: alignment.modelVersion,
  };
  const transcriptMissingChunkIds = new Set(
    Array.isArray(transcript.missingChunkIds)
      ? transcript.missingChunkIds.filter(nonEmptyString)
      : [],
  );

  return {
    commit: async (tx) => {
      const persisted = await persistAlignmentsInTransaction({
        tx,
        actor,
        sessionId,
        alignments,
        transcriptSource: "server-derived",
        provenance,
        requestTrace,
      });
      if (
        persisted.persisted === 0 ||
        persisted.skippedInvalidStatus > 0 ||
        persisted.skippedUnknownWord > 0 ||
        persisted.skippedUnusableSpan > 0
      ) {
        throw Object.assign(new Error("preflight and finalization persistence disagree"), {
          jobErrorCode: "finalization_conflict",
        });
      }

      const realtimeLosses = await tx`
        SELECT chunk_id
        FROM realtime_audio_chunk_outcomes
        WHERE tenant_id = ${actor.tenantId}
          AND session_id = ${sessionId}
          AND initial_outcome = 'accepted-lost'
          AND repaired_at IS NULL`;
      const missingChunkIds = new Set(transcriptMissingChunkIds);
      for (const row of realtimeLosses) missingChunkIds.add(row.chunk_id);
      const lostChunkCount = missingChunkIds.size;
      if (lostChunkCount > 0) {
        console.warn(
          "session finalized with chunks accepted upstream but never stored; transcript is incomplete",
        );
      }
      await tx`
        UPDATE recitation_sessions SET lost_chunk_count = ${lostChunkCount}
        WHERE id = ${sessionId} AND tenant_id = ${actor.tenantId}`;

      return { response: {
        // recitation.rs:1600. What the aligner OFFERED, so `persisted: 0` reads as "all rejected"
        // rather than "nothing was recited" — the two the old response could not distinguish. The
        // Node port omitted the field entirely, so a client through the shell lost that distinction.
        //
        // First in the literal because key ORDER is wire contract here: serde_json is BTreeMap-backed
        // so the Rust body is alphabetical, and the parity harness compares the order separately from
        // the values.
        alignmentsOffered: alignments.length,
        auditEventId: persisted.auditEventId,
        chunkCount: Number.isInteger(transcript.chunkCount) ? transcript.chunkCount : 0,
        finalized: true,
        lostChunkCount,
        ...recoveryResponseFields(recoveryReport, lostChunkCount),
        persisted: persisted.persisted,
        reason: "consent-granted",
        sessionId,
      } };
    },
  };
}

/** POST /v1/recitation-sessions/{id}/finalize — recitation.rs:1183 */
export async function finalizeSession(req, reply, ctx) {
  // Preserve the established authorization-before-shape boundary: an anonymous caller must not
  // learn whether a recovery document is syntactically valid.
  const resolved = await resolveActor(req, ctx);
  let recoveryReport;
  try {
    recoveryReport = validateRecoveryReportBody(req.body);
  } catch (error) {
    throw new RejectionError(error instanceof Error ? error.message : "invalid recovery report", 400);
  }
  if (resolved.delegate) {
    if (recoveryReport !== null) {
      throw new ApiError("recovery reporting is unavailable on the legacy upstream", 503);
    }
    return proxy(req, reply, ctx.upstream);
  }
  const { actor } = resolved;
  const sessionId = req.params.id;
  const inputVersion = await authorizeFinalization(ctx, actor, sessionId, recoveryReport);
  const job = await ctx.jobStore.enqueue({
    tenantId: actor.tenantId,
    kind: "session.finalize",
    subjectId: sessionId,
    actorId: actor.userId,
    idempotencyKey: `session.finalize:${actor.userId}:${sessionId}:${inputVersion}`,
    payload: { sessionId, inputVersion, requestTrace: traceId(req) },
  });
  const body = await waitForJobResult(ctx, job);

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

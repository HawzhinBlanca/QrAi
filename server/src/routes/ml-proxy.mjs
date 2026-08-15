/**
 * N16 — the ML and ASR proxies. Port of handlers/ml_proxy.rs.
 *
 * ── What these routes are FOR ───────────────────────────────────────────────────────────────────
 * The browser must never reach the inference worker or ASR service directly. It once posted audio straight to
 * :8091, which had no auth at all. These four routes exist so the API keys stay server-side and the
 * request is authenticated before any audio leaves.
 *
 * ── Three things the client says that the server OVERWRITES ─────────────────────────────────────
 * 1. `tenantId` — replaced with the actor's server-validated tenant. Otherwise a learner
 *    authenticated for tenant A sets `tenantId: "tenant-B"` and the inference runtime writes audit and
 *    storage records under another tenant's namespace.
 * 2. `consent` — replaced with the record captured when the SESSION was created. The inference runtime
 *    decides external-ASR and child-safety gating from this object, so a client re-supplying
 *    `{guardianApproved: true, externalAsrProcessing: true}` would be claiming approval it never
 *    gave. The only trustworthy consent is the stored one.
 * 3. model identity — every `modelVersion` or `modelAttribution` request field is REFUSED. The
 *    producer authors the identity and this boundary validates it before returning the result.
 *
 * These are the three fields that make this a security boundary rather than a forwarder.
 */
import { createHash, randomUUID } from "node:crypto";

import { waitForJobResult } from "../jobs/wait-for-job.mjs";
import { ApiError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { createDeadline } from "../lib/deadline.mjs";
import { clearsLearnerFeedbackGate } from "../lib/learner-feedback-gate.mjs";
import { requireProducerAttribution } from "../lib/model-attribution.mjs";
import { proxy } from "../lib/proxy.mjs";
import { postJson } from "../lib/upstream.mjs";

const newId = (prefix) => `${prefix}-${randomUUID()}`;

/** `severity` has a CHECK constraint; an unknown value would be a 500 on a learner's request. */
const SEVERITIES = ["practice", "warning", "critical"];

/**
 * Forward to an internal service and map every failure to a GENERIC 502.
 *
 * The underlying error can carry the internal service URL and connection details, so it is logged
 * server-side and never returned. Three distinct messages, matching the Rust, because they tell an
 * operator reading logs which stage failed: unreachable, bad status, or unparseable body.
 *
 * The parse branch logs NO error object, and that is not fastidiousness. Node's `JSON.parse`
 * SyntaxError quotes the first ~10 characters of the input it choked on —
 *   `Unexpected token 'b', "bismillah-"... is not valid JSON`
 * — so interpolating it wrote upstream response bytes into the log. On the ASR path those bytes are
 * a learner's transcript. The stage label already carries the operational signal the comment above
 * claims for it; the error object only ever added the content. (N-7, `no-secret-logging.test.mjs`.)
 */
/**
 * Who may analyse a session that is not their own, and therefore who receives the findings
 * unredacted. ONE list for both, mirroring `ANALYSIS_STAFF` in ml_proxy.rs. Teacher is deliberately
 * absent: reviewing a stored finding is `/v1/teacher-reviews`, not re-running the analyser.
 */
const ANALYSIS_STAFF = ["admin", "ops"];

/**
 * The learner-facing gate — `clears_learner_gate` (review.rs), `canShowLearnerFacingAiOutput`
 * (packages/contracts). An ALLOWLIST of statuses: a denylist fails open on anything this code has
 * not heard of, and failing open here hands a learner an unreviewed judgement.
 * tests/contract/tajweed-gate-parity.test.mjs pins the floor across every implementation.
 */
// Exported for the corpus test in tests/node-api/authz.test.mjs, and for no other caller.
//
// packages/contracts/fixtures/canonical-gates.json exists so that every implementation of this rule
// is held to ONE table of cases. This one could not be: it was module-private, so the corpus listed
// it under "does NOT load this file" and it was covered only by A/B parity — which is blind to a
// change applied to both implementations, the exact hole this session opened with.
//
// Exporting a pure predicate so a test can execute it is a smaller price than a safety gate nobody
// can hold to the shared table.
export function clearsLearnerGate(finding) {
  return clearsLearnerFeedbackGate(finding);
}

/**
 * Strip, in place, the content of every finding a learner may not be shown.
 *
 * The array keeps its length and each finding keeps its `reviewStatus`, because both clients render
 * "N notes are waiting for a teacher" from a count and a count is not a judgement about how the
 * person recited. `confidence: 0` and `sources: []` are not filler — they make the redacted finding
 * fail the client gate on its own merits.
 */
export function redactWithheldFindings(result) {
  if (result === null || typeof result !== "object") return;
  if (!Array.isArray(result?.findings)) {
    if ("findings" in result) result.findings = [];
    return;
  }
  for (let i = 0; i < result.findings.length; i++) {
    const finding = result.findings[i];
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      result.findings[i] = {
        wordId: "",
        rule: "",
        arabicName: "",
        category: "",
        severity: "practice",
        explanation: "",
        confidence: 0,
        reviewStatus: "ai-suggested",
        sources: [],
        withheld: true,
      };
      continue;
    }
    if (clearsLearnerGate(finding)) continue;
    for (const field of ["rule", "arabicName", "category", "severity", "explanation", "wordId"]) {
      if (field in finding) finding[field] = "";
    }
    finding.confidence = 0;
    finding.sources = [];
    finding.withheld = true;
  }
}

/**
 * The caller's trace, exactly as `extract_trace_id` (auth.rs:311) reads it: trimmed, and absent when
 * empty. Not `req.headers["x-trace-id"] ?? null` — the other Node routes use that, but here the value
 * crosses into another service's audit record, and " " forwarded as a trace is a trace that joins
 * nothing while looking like it does.
 */
function callerTrace(req) {
  const raw = req.headers["x-trace-id"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The shared ML path — `proxy_ml` (ml_proxy.rs:19). */
/** Refuse any upstream attempt to blur canonical instruction into learner performance. */
function requireTajweedSemantics(result) {
  if (!Array.isArray(result?.annotations) || !Array.isArray(result?.findings)) {
    throw new ApiError("ML service returned an invalid response", 502);
  }
  for (const annotation of result.annotations) {
    if (
      annotation === null ||
      typeof annotation !== "object" ||
      annotation.analysisBasis !== "text-rule" ||
      annotation.instructional !== true ||
      ["confidence", "severity", "reviewStatus"].some((field) => Object.hasOwn(annotation, field))
    ) {
      console.error("ML proxy: invalid instructional Tajweed annotation semantics");
      throw new ApiError("ML service returned an invalid response", 502);
    }
  }

  const sha256 = /^sha256:[a-f0-9]{64}$/;
  const requiredIds = [
    "modelVersion",
    "acousticDatasetVersion",
    "calibratorId",
    "evaluationEvidenceId",
  ];
  const requiredDigests = [
    "modelArtifactSha256",
    "acousticDatasetManifestSha256",
    "calibratorArtifactSha256",
    "evaluationEvidenceSha256",
  ];
  for (const finding of result.findings) {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    if (
      finding === null ||
      typeof finding !== "object" ||
      finding.analysisBasis !== "acoustic" ||
      finding.reviewStatus !== "ai-suggested" ||
      typeof finding.wordId !== "string" ||
      finding.wordId.length === 0 ||
      typeof finding.rule !== "string" ||
      finding.rule.length === 0 ||
      typeof finding.explanation !== "string" ||
      !SEVERITIES.includes(finding.severity) ||
      typeof finding.confidence !== "number" ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1 ||
      Object.hasOwn(finding, "instructional") ||
      requiredIds.some((field) => typeof finding[field] !== "string" || finding[field].length === 0) ||
      requiredDigests.some((field) => !sha256.test(finding[field] ?? "")) ||
      finding.modelVersion !== result.modelVersion ||
      sources.length === 0 ||
      sources.some(
        (source) =>
          source === null ||
          typeof source !== "object" ||
          typeof source.id !== "string" ||
          source.id.length === 0 ||
          typeof source.title !== "string" ||
          source.title.length === 0 ||
          typeof source.citation !== "string" ||
          source.citation.length === 0,
      )
    ) {
      console.error("ML proxy: invalid acoustic Tajweed finding semantics");
      throw new ApiError("ML service returned an invalid response", 502);
    }
  }
}

/** Match serde_json's BTreeMap order for an untyped top-level proxy response. */
function orderJsonObjectKeys(value) {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

const evaluationHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function proxyMl(req, reply, ctx, label, path) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);
  const { actor } = resolved;

  // Note: NO role gate. Any authenticated actor may run analysis; the session ownership check
  // below is what scopes it.
  const body = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("request body must be a JSON object", 400);
  }

  if (Object.hasOwn(body, "modelVersion") || Object.hasOwn(body, "modelAttribution")) {
    throw new ApiError("model identity is server-selected and must not be supplied", 400);
  }
  if (Object.hasOwn(body, "learnerId")) {
    throw new ApiError("learnerId is server-derived and must not be supplied", 400);
  }
  if (Object.hasOwn(body, "acousticSegments")) {
    throw new ApiError("acousticSegments are server-derived and must not be supplied", 400);
  }
  if (Object.hasOwn(body, "recognizedTokens")) {
    // Measured tokens become persistable evidence in the internal finalize chain. A public caller
    // can report practice text, but cannot author timestamps and have them relabelled server-derived.
    throw new ApiError("recognizedTokens are server-derived and must not be supplied", 400);
  }
  if (Object.hasOwn(body, "transcriptModelAttribution")) {
    // This envelope identifies the private ASR/forced-aligner workers that produced the measured
    // token spans. Accepting it from a public caller would make an invented producer indistinguish-
    // able from the finalizer's server-to-server chain.
    throw new ApiError(
      "transcriptModelAttribution is server-derived and must not be supplied",
      400,
    );
  }

  // Server-authoritative tenant: ignore whatever the client claimed.
  const forwarded = { ...body, tenantId: actor.tenantId };

  // The trace has to cross the boundary or the two audit trails cannot be joined (P5.3). This
  // API audits the trace from `x-trace-id`; the worker runtime audits `requestBody.traceId`. The
  // forward carried neither, so one side recorded the caller's trace, the other recorded null, and
  // "which ML call produced this finding" had no answer.
  //
  // Overwritten rather than defaulted, exactly like `tenantId` above: a caller who can set
  // `traceId` in the body can make the two services disagree about their own audit trail.
  const trace = callerTrace(req);
  if (trace !== null) forwarded.traceId = trace;

  if (typeof body.sessionId === "string") {
    const context = await ctx.db.withTenant(actor.tenantId, async (tx) => {
      const [row] = await tx`
        SELECT s.learner_id, s.quran_ref, s.source_checksum,
               c.guardian_approved, c.external_asr_processing, c.audio_retention
        FROM recitation_sessions s
        JOIN consent_records c ON c.id = s.consent_record_id
        WHERE s.id = ${body.sessionId} AND s.tenant_id = ${actor.tenantId}`;

      let acousticSegments = [];
      if (label === "tajweed" && row) {
        const measured = await tx`
          SELECT word_id, start_ms, end_ms
          FROM word_alignments
          WHERE session_id = ${body.sessionId}
            AND tenant_id = ${actor.tenantId}
            AND transcript_source = 'server-derived'
            AND status IN ('matched', 'misread')
            AND start_ms >= 0
            AND end_ms > start_ms
          ORDER BY start_ms, end_ms, word_id`;
        acousticSegments = measured.map((segment) => ({
          wordId: segment.word_id,
          startMs: Number(segment.start_ms),
          endMs: Number(segment.end_ms),
        }));
      }
      return { row, acousticSegments };
    });
    const { row, acousticSegments } = context;

    // 403, NOT 404. A session that is not yours and a session that does not exist give the same
    // answer, so this cannot be used to discover which session ids exist in the tenant.
    if (!row) throw new ApiError("actor is not allowed to perform this action", 403);

    // A learner may only analyse their OWN session; admin/ops may analyse any in-tenant session.
    // Without this a learner passes another in-tenant learner's sessionId and has THAT session's
    // stored consent applied to their own forwarded audio.
    requireSelfOrAny(actor, row.learner_id, ANALYSIS_STAFF);

    // Server-authoritative CONSENT, from the record captured at session creation.
    forwarded.consent = {
      guardianApproved: row.guardian_approved,
      externalAsrProcessing: row.external_asr_processing,
      audioRetention: row.audio_retention,
    };

    // Server-authoritative LEARNER, from the same session row the ownership check just approved.
    // Alignment and tajweed audit rows are keyed by sessionId, so the inference runtime needs this
    // attribution to include the learner's own history while excluding every other tenant member.
    // It must never come from `body.learnerId`, which is rejected above.
    forwarded.learnerId = row.learner_id;

    if (label === "tajweed") {
      // These four values identify the retained bytes and the only measured spans the acoustic
      // worker may observe. Every caller-supplied value is discarded at this boundary.
      forwarded.quranRef = row.quran_ref;
      forwarded.sourceChecksum = row.source_checksum;
      forwarded.acousticSegments = acousticSegments;
    }
  }

  if (label === "tajweed" && typeof body.sessionId === "string") {
    // Persist only the closed, server-authoritative inference envelope. Arbitrary caller fields are
    // neither necessary for Tajweed evaluation nor acceptable durable queue material.
    const input = {
      acousticSegments: forwarded.acousticSegments,
      consent: forwarded.consent,
      learnerId: forwarded.learnerId,
      quranRef: forwarded.quranRef,
      sessionId: body.sessionId,
      sourceChecksum: forwarded.sourceChecksum,
      tenantId: actor.tenantId,
      ...(trace === null ? {} : { traceId: trace }),
    };
    const inputVersion = evaluationHash(input);
    const job = await ctx.jobStore.enqueue({
      tenantId: actor.tenantId,
      kind: "session.evaluate",
      subjectId: body.sessionId,
      actorId: actor.userId,
      idempotencyKey: `session.evaluate:${actor.userId}:${actor.role}:${body.sessionId}:${inputVersion}`,
      payload: {
        input,
        inputVersion,
        requestTrace: trace,
        responseRole: actor.role,
      },
    });
    return reply.send(await waitForJobResult(ctx, job));
  }

  const result = await postJson({
    url: `${ctx.mlInferenceUrl}${path}`,
    keyHeader: "x-ml-api-key",
    keyValue: ctx.mlApiKey,
    body: forwarded,
    label,
    service: "ML",
    timeoutMs: ctx.upstreamTimeoutMs,
    deadline: ctx.deadline,
  });

  if (label === "alignment") {
    requireProducerAttribution(result, "quran-aligner", "ML");
  }
  if (label === "tajweed") {
    requireTajweedSemantics(result);
  }

  // Store what the model said, so a teacher can review it — `persist_tajweed_findings`
  // (ml_proxy.rs:297). W1.10 returns zero public findings because the acoustic probabilities are
  // uncalibrated; later calibrated outputs still pass through this existing review boundary.
  // The learner gate applies to the RESPONSE — ml_proxy.rs `redact_withheld_findings`.
  if (label === "tajweed" && !ANALYSIS_STAFF.includes(actor.role)) {
    redactWithheldFindings(result);
  }

  // Rust forwards this untyped serde_json::Value through a BTreeMap-backed object, which sorts the
  // top-level keys. Keep the portable Node response byte-compatible after adding annotations and
  // findings; otherwise those late-added keys move to the end only on Node.
  return reply.send(label === "tajweed" ? orderJsonObjectKeys(result) : result);
}

/**
 * Store the findings a prediction produced — `persist_tajweed_findings` (ml_proxy.rs:297).
 *
 * The constraint ORDER is Rust's and is load-bearing:
 *   1. already-analysed check FIRST, so the common re-run path costs one query
 *   2. wordId -> alignment id, this session only — no alignments means no evidence to anchor to
 *   3. the tajweed model resolved BY KIND; anything but exactly one match refuses rather than guesses
 * and the audit row is inserted before the findings that FK-reference it.
 *
 * Everything not-storable is SKIPPED, never a 500: a learner asking for analysis must not get an
 * error because the model named a word that is not in their alignment set.
 */
export async function persistTajweedFindingsInTransaction({
  tx,
  actor,
  sessionId,
  result,
  trace,
}) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (findings.length === 0) return;

    const [existing] = await tx`
      SELECT 1 FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE wa.session_id = ${sessionId} AND wa.tenant_id = ${actor.tenantId} LIMIT 1`;
    if (existing) return;

    const alignmentRows = await tx`
      SELECT id, word_id FROM word_alignments
      WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
    if (alignmentRows.length === 0) return;
    const alignments = new Map(alignmentRows.map((row) => [row.word_id, row.id]));

    const storable = findings.flatMap((finding) => {
      const alignmentId = alignments.get(finding.wordId);
      return alignmentId === undefined ? [] : [{ finding, alignmentId }];
    });
    if (storable.length === 0) return;

    for (const { finding } of storable) {
      const [authority] = await tx`
        SELECT 1
          FROM eval_runs
         WHERE tenant_id = ${actor.tenantId}
           AND model_version_id = ${finding.modelVersion}
           AND evaluation_task = 'acoustic-tajweed'
           AND evidence_kind = 'row-level-computed-evaluation'
           AND evidence_eligibility = 'release-candidate'
           AND release_eligible
           AND passed
           AND evidence_id = ${finding.evaluationEvidenceId}
           AND evidence_payload_sha256 = ${finding.evaluationEvidenceSha256}
           AND model_artifact_sha256 = ${finding.modelArtifactSha256}
           AND dataset_version = ${finding.acousticDatasetVersion}
           AND dataset_manifest_sha256 = ${finding.acousticDatasetManifestSha256}
           AND calibrator_id = ${finding.calibratorId}
           AND calibrator_artifact_sha256 = ${finding.calibratorArtifactSha256}
         FOR KEY SHARE`;
      if (!authority) {
        throw new ApiError("tajweed findings could not be recorded for review", 502);
      }
    }

    const auditId = newId("audit");
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'ml.tajweed.persisted',
              'recitation_session', ${sessionId},
              ${tx.json({ trace_id: trace, findingCount: storable.length })})`;

    for (const { finding, alignmentId } of storable) {
      await tx`
        INSERT INTO tajweed_findings
          (id, tenant_id, alignment_id, rule, severity, confidence, explanation,
           review_status, source_refs, model_version_id, audit_event_id, analysis_basis,
           evaluation_evidence_id, evaluation_evidence_sha256, model_artifact_sha256,
           acoustic_dataset_version, acoustic_dataset_manifest_sha256, calibrator_id,
           calibrator_artifact_sha256)
        VALUES (${newId("tajweed-finding")}, ${actor.tenantId}, ${alignmentId},
                ${finding.rule}, ${finding.severity}, ${finding.confidence}::float8::numeric,
                ${finding.explanation}, 'ai-suggested', ${tx.json(finding.sources)},
                ${finding.modelVersion}, ${auditId}, 'acoustic',
                ${finding.evaluationEvidenceId}, ${finding.evaluationEvidenceSha256},
                ${finding.modelArtifactSha256}, ${finding.acousticDatasetVersion},
                ${finding.acousticDatasetManifestSha256}, ${finding.calibratorId},
                ${finding.calibratorArtifactSha256})`;
    }
}

/** Repeatable external session evaluation; only the returned fenced commit writes findings. */
export async function prepareSessionEvaluation({ ctx, job, signal }) {
  const deadline = createDeadline(ctx.upstreamTimeoutMs, { parentSignal: signal });
  const result = await ctx.inference.predictTajweed(job.payload.input, deadline);
  requireTajweedSemantics(result);

  const response = structuredClone(result);
  if (!ANALYSIS_STAFF.includes(job.payload.responseRole)) redactWithheldFindings(response);
  return {
    result: { response: orderJsonObjectKeys(response) },
    commit: async (tx) => persistTajweedFindingsInTransaction({
      tx,
      actor: { tenantId: job.tenantId, userId: job.actorId },
      sessionId: job.subjectId,
      result,
      trace: job.payload.requestTrace,
    }),
  };
}

/** The shared ASR path — `proxy_asr` (ml_proxy.rs:211). */
async function proxyAsr(req, reply, ctx, label, path) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);

  // Authentication alone is the control here, and that is deliberate: there is no tenantId to
  // override because transcribe/force-align perform no tenant-scoped writes — they return
  // recognized text and timestamps. The body is otherwise forwarded unchanged — except for the
  // trace, without which the ASR service audits null while this one audits the caller's, and the
  // two records of the same audio cannot be joined.
  const trace = callerTrace(req);
  const body =
    trace !== null && req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
      ? { ...req.body, traceId: trace }
      : req.body;

  const result = await postJson({
    url: `${ctx.asrInferenceUrl}${path}`,
    keyHeader: "x-asr-api-key",
    keyValue: ctx.asrApiKey,
    body,
    label,
    service: "ASR",
    timeoutMs: ctx.upstreamTimeoutMs,
    deadline: ctx.deadline,
  });

  requireProducerAttribution(
    result,
    label === "force-align" ? "forced-aligner" : "asr",
    "ASR",
  );
  return reply.send(result);
}

export const predictAlignment = (req, reply, ctx) =>
  proxyMl(req, reply, ctx, "alignment", "/v1/alignments:predict");

export const predictTajweed = (req, reply, ctx) =>
  proxyMl(req, reply, ctx, "tajweed", "/v1/tajweed-findings:predict");

export const asrTranscribe = (req, reply, ctx) =>
  proxyAsr(req, reply, ctx, "transcribe", "/v1/transcribe");

export const asrForceAlign = (req, reply, ctx) =>
  proxyAsr(req, reply, ctx, "force-align", "/v1/force-align");

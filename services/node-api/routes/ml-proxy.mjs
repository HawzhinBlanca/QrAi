/**
 * N16 — the ML and ASR proxies. Port of handlers/ml_proxy.rs.
 *
 * ── What these routes are FOR ───────────────────────────────────────────────────────────────────
 * The browser must never reach the ML or ASR service directly. It once posted audio straight to
 * :8091, which had no auth at all. These four routes exist so the API keys stay server-side and the
 * request is authenticated before any audio leaves.
 *
 * ── Three things the client says that the server OVERWRITES ─────────────────────────────────────
 * 1. `tenantId` — replaced with the actor's server-validated tenant. Otherwise a learner
 *    authenticated for tenant A sets `tenantId: "tenant-B"` and the ML service writes audit and
 *    storage records under another tenant's namespace.
 * 2. `consent` — replaced with the record captured when the SESSION was created. The ML service
 *    decides external-ASR and child-safety gating from this object, so a client re-supplying
 *    `{guardianApproved: true, externalAsrProcessing: true}` would be claiming approval it never
 *    gave. The only trustworthy consent is the stored one.
 * 3. `modelVersion` — not overwritten but REFUSED when it is not on the approved list, so an
 *    experimental model cannot be driven from a request body.
 *
 * These are the three fields that make this a security boundary rather than a forwarder.
 */
import { randomUUID } from "node:crypto";

import { ApiError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { proxy } from "../lib/proxy.mjs";

/** ml_proxy.rs:32 — the runtime allowlist. An unapproved model is a 400, not a silent downgrade. */
const APPROVED_MODELS = ["ml-aligner-v0.2"];

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
async function forward({ url, keyHeader, keyValue, body, label, service }) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [keyHeader]: keyValue },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`${service} proxy ${label} send error: ${e}`);
    throw new ApiError(`${service} service unavailable`, 502);
  }

  if (!response.ok) {
    console.warn(`${service} proxy ${label} upstream status ${response.status}`);
    throw new ApiError(`${service} service error`, 502);
  }

  try {
    return await response.json();
  } catch {
    console.error(`${service} proxy ${label}: upstream response was not valid JSON`);
    throw new ApiError(`${service} service returned an invalid response`, 502);
  }
}

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
  const approved =
    finding?.reviewStatus === "teacher-reviewed" || finding?.reviewStatus === "scholar-approved";
  const confidence = typeof finding?.confidence === "number" ? finding.confidence : 0;
  const sources = Array.isArray(finding?.sources) ? finding.sources : [];
  // Term order is deliberate — the parity test recognises this gate by the provenance check
  // following the confidence floor, so every implementation of it reads the same way.
  return approved && confidence >= 0.82 && sources.length > 0;
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
  if (result === null || typeof result !== "object" || !("findings" in result)) {
    // No `findings` key at all: the response claims nothing about how the person recited, so there
    // is nothing to gate. A legitimate ML response shape; untouched.
    return;
  }

  // ── Shapes this function was NOT written to inspect ─────────────────────────────────────────
  // Both branches here forwarded the value UNREDACTED, which is the gate failing OPEN on exactly
  // the input it cannot reason about — reachable without anyone editing the gate: a partially
  // migrated model server, a debug build with a different schema, or a compromised ML service.
  // handlers/ml_proxy.rs fixed both and says so in its own comment; this port kept the old
  // behaviour, so a cutover to node-api would have silently reopened an ADR-0028 gate that the
  // Rust side had already closed.
  //
  // The rule (ADR-0028) is that learner-facing model output does not leave this service without
  // source, confidence and an approval gate. "A client probably would not render it" is not that
  // rule — it is the reasoning that put the gate on the wrong side of the boundary to begin with.
  if (!Array.isArray(result.findings)) {
    console.error("ML proxy: `findings` was present but not an array; dropping ungated model output");
    result.findings = [];
    return;
  }

  for (let i = 0; i < result.findings.length; i++) {
    const finding = result.findings[i];
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      // Not an object, so its fields cannot be cleared one by one. Replace it wholesale rather than
      // passing it through: the array keeps its length, which is what both clients count to render
      // "N notes are waiting for a teacher", and it carries no model text.
      console.error("ML proxy: a finding was not an object; replacing it with a withheld placeholder");
      result.findings[i] = { withheld: true, confidence: 0, sources: [] };
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

  const modelVersion = body.modelVersion;
  if (typeof modelVersion === "string" && !APPROVED_MODELS.includes(modelVersion)) {
    throw new ApiError(`Model version '${modelVersion}' is not approved for production use`, 400);
  }

  // Server-authoritative tenant: ignore whatever the client claimed.
  const forwarded = { ...body, tenantId: actor.tenantId };

  // The trace has to cross the boundary or the two audit trails cannot be joined (P5.3). This
  // service audits the trace from `x-trace-id`; ml-inference audits `requestBody.traceId`. The
  // forward carried neither, so one side recorded the caller's trace, the other recorded null, and
  // "which ML call produced this finding" had no answer.
  //
  // Overwritten rather than defaulted, exactly like `tenantId` above: a caller who can set
  // `traceId` in the body can make the two services disagree about their own audit trail.
  const trace = callerTrace(req);
  if (trace !== null) forwarded.traceId = trace;

  if (typeof body.sessionId === "string") {
    const row = await ctx.db.withTenant(actor.tenantId, async (tx) => {
      const [r] = await tx`
        SELECT s.learner_id, c.guardian_approved, c.external_asr_processing, c.audio_retention
        FROM recitation_sessions s
        JOIN consent_records c ON c.id = s.consent_record_id
        WHERE s.id = ${body.sessionId} AND s.tenant_id = ${actor.tenantId}`;
      return r;
    });

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

    // Server-authoritative LEARNER, from the same row the authz check above just read. Parity with
    // handlers/ml_proxy.rs, and for the same reason consent is overwritten rather than trusted: the
    // server's answer, not the client's claim. ml-inference keys its external-ASR and prediction
    // audit rows by sessionId, so with no learner on the request those rows are attributable to
    // nobody — and a learner-scoped privacy export has to drop them. Sending it is what keeps a
    // learner's own history in their export while another learner's stays out of it.
    forwarded.learnerId = row.learner_id;
  }

  const result = await forward({
    url: `${ctx.mlInferenceUrl}${path}`,
    keyHeader: "x-ml-api-key",
    keyValue: ctx.mlApiKey,
    body: forwarded,
    label,
    service: "ML",
  });

  // Store what the model said, so a teacher can review it — `persist_tajweed_findings`
  // (ml_proxy.rs:297). Measured absent from this service: a prediction served here returned five
  // findings and wrote ZERO rows, where Rust wrote a finding and an audit event from the same
  // request. The responses were byte-identical, so the A/B differ could not see it.
  if (label === "tajweed" && typeof result?.sessionId === "string") {
    await persistTajweedFindings(ctx, actor, result.sessionId, result, trace);
  }

  // The learner gate applies to the RESPONSE — ml_proxy.rs `redact_withheld_findings`. Everything
  // this route returns is freshly computed and `ai-suggested`, so for a learner the whole set is
  // withheld; it was being sent to their device in full with the client trusted to hide it.
  if (label === "tajweed" && !ANALYSIS_STAFF.includes(actor.role)) {
    redactWithheldFindings(result);
  }

  return reply.send(result);
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
async function persistTajweedFindings(ctx, actor, sessionId, result, trace) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (findings.length === 0) return;

  await ctx.db.withTenant(actor.tenantId, async (tx) => {
    const [existing] = await tx`
      SELECT 1 FROM tajweed_findings tf
      JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE wa.session_id = ${sessionId} AND wa.tenant_id = ${actor.tenantId} LIMIT 1`;
    if (existing) return;

    const alignmentRows = await tx`
      SELECT id, word_id FROM word_alignments
      WHERE session_id = ${sessionId} AND tenant_id = ${actor.tenantId}`;
    // "there is no evidence a finding could point at" — not an error, and not a stored finding
    // floating free of the recitation it is supposedly about.
    if (alignmentRows.length === 0) return;
    const alignments = new Map(alignmentRows.map((r) => [r.word_id, r.id]));

    const models = await tx`SELECT id FROM model_versions WHERE kind = 'tajweed' ORDER BY id`;
    if (models.length !== 1) {
      // Refusing to guess which model produced these findings. A finding attributed to the wrong
      // model version is worse than no finding: it is evidence pointing at the wrong thing.
      throw new ApiError("tajweed findings could not be recorded for review", 502);
    }
    const modelVersionId = models[0].id;

    const auditId = newId("audit");
    // Ordered before the findings, which FK-reference it. `actor_id` REFERENCES users(id), so it is
    // the authenticated caller — a synthetic 'ml-inference' is a foreign-key violation, which would
    // surface as a 500 on a learner's analysis request. The caller is the honest answer anyway:
    // they asked for the analysis.
    await tx`
      INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
      VALUES (${auditId}, ${actor.tenantId}, ${actor.userId}, 'ml.tajweed.persisted',
              'recitation_session', ${sessionId},
              ${tx.json({ trace_id: trace, findingCount: findings.length })})`;

    for (const finding of findings) {
      if (finding === null || typeof finding !== "object") continue;
      const alignmentId =
        typeof finding.wordId === "string" ? alignments.get(finding.wordId) : undefined;
      if (alignmentId === undefined) continue;
      const severity = typeof finding.severity === "string" ? finding.severity : "";
      if (!SEVERITIES.includes(severity)) continue;

      const rawConfidence = Number(finding.confidence);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.min(1, Math.max(0, rawConfidence))
        : 0;

      // `review_status` and `analysis_basis` are LITERALS below, never fields read from the ML
      // response.
      //
      // 'ai-suggested': this is a model's opinion, and only `create_teacher_review` may move it
      // (ADR-0027).
      //
      // 'canonical-text': analyzeAyah inspects `word.text` — the canonical Uthmani text — and
      // nothing else. No audio, no heard text, no timing, no pitch. Every finding it produces is "a
      // rule applies at this position in the passage", which is true of the text and identical for
      // every learner who ever recites it. Recording that is what lets a teacher tell it apart from
      // a judgement about how THIS learner recited. Hardcoded for the same reason
      // `TranscriptSource::ClientReported` is (ADR-0030): a value read from a response is one
      // refactor away from being caller-controlled, and this one decides whether a teacher trusts
      // what they are looking at. When an acoustic analyser exists, writing `acoustic` will be a
      // deliberate code change with its own review.
      await tx`
        INSERT INTO tajweed_findings
          (id, tenant_id, alignment_id, rule, severity, confidence, explanation,
           review_status, source_refs, model_version_id, audit_event_id, analysis_basis)
        VALUES (${newId("tajweed-finding")}, ${actor.tenantId}, ${alignmentId},
                ${typeof finding.rule === "string" ? finding.rule : ""},
                ${severity},
                ${confidence}::float8::numeric,
                ${typeof finding.explanation === "string" ? finding.explanation : ""},
                'ai-suggested', ${tx.json(Array.isArray(finding.sources) ? finding.sources : [])},
                ${modelVersionId}, ${auditId}, 'canonical-text')`;
    }
  });
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

  const result = await forward({
    url: `${ctx.asrInferenceUrl}${path}`,
    keyHeader: "x-asr-api-key",
    keyValue: ctx.asrApiKey,
    body,
    label,
    service: "ASR",
  });

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

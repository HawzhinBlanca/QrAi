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
import { ApiError, requireSelfOrAny, resolveActor } from "../lib/authz.mjs";
import { proxy } from "../lib/proxy.mjs";

/** ml_proxy.rs:32 — the runtime allowlist. An unapproved model is a 400, not a silent downgrade. */
const APPROVED_MODELS = ["ml-aligner-v0.2"];

/**
 * Forward to an internal service and map every failure to a GENERIC 502.
 *
 * The underlying error can carry the internal service URL and connection details, so it is logged
 * server-side and never returned. Three distinct messages, matching the Rust, because they tell an
 * operator reading logs which stage failed: unreachable, bad status, or unparseable body.
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
  } catch (e) {
    console.error(`${service} proxy ${label} parse error: ${e}`);
    throw new ApiError(`${service} service returned an invalid response`, 502);
  }
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
    requireSelfOrAny(actor, row.learner_id, ["admin", "ops"]);

    // Server-authoritative CONSENT, from the record captured at session creation.
    forwarded.consent = {
      guardianApproved: row.guardian_approved,
      externalAsrProcessing: row.external_asr_processing,
      audioRetention: row.audio_retention,
    };
  }

  const result = await forward({
    url: `${ctx.mlInferenceUrl}${path}`,
    keyHeader: "x-ml-api-key",
    keyValue: ctx.mlApiKey,
    body: forwarded,
    label,
    service: "ML",
  });

  return reply.send(result);
}

/** The shared ASR path — `proxy_asr` (ml_proxy.rs:211). */
async function proxyAsr(req, reply, ctx, label, path) {
  const resolved = await resolveActor(req, ctx);
  if (resolved.delegate) return proxy(req, reply, ctx.upstream);

  // Authentication alone is the control here, and that is deliberate: there is no tenantId to
  // override because transcribe/force-align perform no tenant-scoped writes — they return
  // recognized text and timestamps. The body is forwarded UNCHANGED.
  const result = await forward({
    url: `${ctx.asrInferenceUrl}${path}`,
    keyHeader: "x-asr-api-key",
    keyValue: ctx.asrApiKey,
    body: req.body,
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

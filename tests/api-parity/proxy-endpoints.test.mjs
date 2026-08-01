import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { queryJson, request, startApi, startMockUpstream } from "./lib/harness.mjs";

/**
 * C2 — the three proxy pairs that had neither a fixture nor a parity test.
 * specs/contract-coverage-closure/plan.md §5
 *
 * ── A correction the plan needed ───────────────────────────────────────────────────────────────
 * The plan's acceptance said "upstream status is preserved, not translated". **That is wrong for
 * these routes**, and asserting it would have pinned a contract the server does not implement.
 *
 * `proxy_ml` and `proxy_asr` (ml_proxy.rs) both COLLAPSE any upstream non-success into
 * `ApiError::Upstream` → **502** with a generic message, and log the real error server-side. That is
 * deliberate: the upstream error text can carry the internal ML/ASR URL, and these services sit
 * behind the platform API precisely so the browser never learns they exist.
 *
 * The "status preserved" behaviour I was remembering belongs to the Node strangler shell
 * (tests/node-api/shell.test.mjs), which is a transparent proxy. Different component, opposite and
 * equally deliberate contract. Tested here as it is, not as it was planned.
 */

const AUDIO = { audioBase64: "AAAA", audioFormat: "wav", language: "ar" };

let api;
let ml;
let asr;

before(async () => {
  ml = await startMockUpstream(() => ({ status: 200, body: { findings: [] } }));
  asr = await startMockUpstream(() => ({ status: 200, body: { text: "بسم الله", words: [] } }));
  api = await startApi({ env: { ML_INFERENCE_URL: ml.url, ASR_INFERENCE_URL: asr.url } });
});
after(async () => {
  await api?.stop();
  await ml?.stop();
  await asr?.stop();
});

// ── POST /v1/ml/tajweed-findings:predict ───────────────────────────────────────────────────────

test("tajweed:predict forwards to ML with the SERVER-side key, never the caller's", async () => {
  ml.received.length = 0;
  const res = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    body: { words: [] },
    // A caller trying to smuggle its own upstream key must not be able to influence what is sent.
    headers: { "x-ml-api-key": "attacker-supplied" },
  });
  assert.equal(res.status, 200);

  const [forwarded] = ml.received;
  assert.ok(forwarded, "the request must actually reach the upstream");
  assert.equal(forwarded.path, "/v1/tajweed-findings:predict");
  assert.notEqual(
    forwarded.headers["x-ml-api-key"],
    "attacker-supplied",
    "the proxy must send its OWN key — the whole reason this route exists is that the key is server-side",
  );
  assert.ok(forwarded.headers["x-ml-api-key"], "…and it must send one");

  // The key must never come back out either.
  assert.ok(!res.text.includes(forwarded.headers["x-ml-api-key"]), "upstream key leaked in the response");
});

test("tajweed:predict binds consent to the ACTOR's session, and refuses a foreign one", async () => {
  // The cross-tenant IDOR class already found once in ml_proxy.rs (PR #1): forwarding a
  // caller-supplied identifier verbatim let one learner have ANOTHER learner's stored consent
  // applied to their own audio. ml_proxy.rs:83 now requires self-or-admin/ops on the session owner.
  // Selected by OWNER, not by recency: other suites in this file's DB create sessions constantly,
  // and "the newest session" would occasionally belong to whoever ran last — making the foreign-
  // access assertion pass for the wrong reason, or fail spuriously. The JOIN is required because
  // ml_proxy.rs only reaches the ownership check for a session that has a consent record.
  const [session] = await queryJson(
    `SELECT s.id, s.learner_id FROM recitation_sessions s
     JOIN consent_records c ON c.id = s.consent_record_id
     WHERE s.learner_id = 'learner-1' AND s.tenant_id = $1
     ORDER BY s.started_at DESC LIMIT 1`,
    ["hikmah-pilot-erbil"],
  );
  assert.ok(session, "a recitation session owned by learner-1 with a consent record is required");

  const foreign = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    userId: "learner-2",
    body: { sessionId: session.id, words: [] },
  });
  assert.equal(foreign.status, 403, "a learner must not analyse against another learner's session");
});

test("tajweed:predict maps an upstream failure to a GENERIC 502", async () => {
  // Not a passthrough. The upstream body can name the internal ML host; that is exactly what must
  // not reach a browser.
  ml.respond = () => ({ status: 500, body: { error: "ml-inference at http://10.0.0.7:8090 exploded" } });
  const res = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    body: { words: [] },
  });
  ml.respond = () => ({ status: 200, body: { findings: [] } });

  assert.equal(res.status, 502);
  assert.equal(res.body.error, "ML service error");
  assert.ok(!res.text.includes("10.0.0.7"), "the internal upstream address must never be echoed");
  assert.ok(!res.text.includes("exploded"), "the upstream error body must not be forwarded");
});

test("tajweed:predict requires an authenticated actor", async () => {
  const res = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    tenant: null,
    body: { words: [] },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "missing or invalid authorization");
});

// ── POST /v1/asr/transcribe and /v1/asr/force-align ────────────────────────────────────────────

for (const [route, upstreamPath] of [
  ["/v1/asr/transcribe", "/v1/transcribe"],
  ["/v1/asr/force-align", "/v1/force-align"],
]) {
  test(`${route} forwards to the ASR service with the server-side key`, async () => {
    asr.received.length = 0;
    const res = await request(api.baseUrl, route, {
      method: "POST",
      role: "learner",
      body: AUDIO,
      headers: { "x-asr-api-key": "attacker-supplied" },
    });
    assert.equal(res.status, 200);

    const [forwarded] = asr.received;
    assert.ok(forwarded, "the request must actually reach the ASR upstream");
    assert.equal(forwarded.path, upstreamPath);
    assert.notEqual(forwarded.headers["x-asr-api-key"], "attacker-supplied");
    assert.ok(forwarded.headers["x-asr-api-key"], "the proxy must send its own ASR key");
    // The audio is passed through unchanged — this proxy exists for the key, not to transform.
    assert.equal(forwarded.body.audioBase64, AUDIO.audioBase64);
  });

  test(`${route} requires an authenticated actor`, async () => {
    // Before this proxy existed the browser posted audio straight to :8091, which had no auth at
    // all. Authentication IS the control here: unlike the ML route there is no tenant-scoped write
    // to bind, so if this assertion goes, the route is an open transcription service again.
    const res = await request(api.baseUrl, route, { method: "POST", tenant: null, body: AUDIO });
    assert.equal(res.status, 401);
  });

  test(`${route} maps an upstream failure to a GENERIC 502`, async () => {
    asr.respond = () => ({ status: 503, body: { detail: "asr-inference at http://10.0.0.9:8091 is down" } });
    const res = await request(api.baseUrl, route, { method: "POST", role: "learner", body: AUDIO });
    asr.respond = () => ({ status: 200, body: { text: "بسم الله", words: [] } });

    assert.equal(res.status, 502, "any upstream non-success collapses to 502, not 503");
    assert.equal(res.body.error, "ASR service error");
    assert.ok(!res.text.includes("10.0.0.9"), "the internal ASR address must never be echoed");
  });

  test(`${route} maps a non-JSON upstream body to a 502 rather than a 500`, async () => {
    // A 200 carrying HTML — a proxy error page in front of the ASR service — is the realistic
    // version of this, and it must not surface as a server error on our side.
    asr.respond = () => ({ status: 200, body: "<html>502 Bad Gateway</html>", contentType: "text/html" });
    const res = await request(api.baseUrl, route, { method: "POST", role: "learner", body: AUDIO });
    asr.respond = () => ({ status: 200, body: { text: "بسم الله", words: [] } });

    assert.equal(res.status, 502);
    assert.equal(res.body.error, "ASR service returned an invalid response");
  });
}

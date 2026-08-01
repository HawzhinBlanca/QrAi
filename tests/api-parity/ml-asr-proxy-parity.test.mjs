/**
 * N16 — the ML and ASR proxies: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of handlers/ml_proxy.rs
 *
 *   NODE_API_PORTED="POST /v1/ml/alignments:predict,POST /v1/ml/tajweed-findings:predict,POST /v1/asr/transcribe,POST /v1/asr/force-align" \
 *     node --test tests/api-parity/ml-asr-proxy-parity.test.mjs
 *
 * Both implementations are pointed at the SAME mock upstream, so the comparison is about what the
 * proxy does to the request and the response — not about the ML service. The mock echoes back what
 * it received, which is how the three server-authoritative overwrites are observed rather than
 * assumed.
 *
 * ── A router hazard specific to these paths ─────────────────────────────────────────────────────
 * `/v1/ml/alignments:predict` contains a colon MID-SEGMENT. Fastify's router reads `:name` as a
 * PARAMETER, so a naive registration can match `/v1/ml/alignmentsXYZ` as well — a route that
 * quietly serves paths the contract never mentions. There is a test for exactly that below.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertABMutating } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startMockUpstream, startShell } from "./lib/harness.mjs";

let api;
let shell;
let mock;
let received;
let learnerId;
let sessionId;

before(async () => {
  received = [];
  mock = await startMockUpstream(({ path, body }) => {
    received.push({ path, body });
    // Echo, so the test can see exactly what the proxy forwarded.
    return { status: 200, body: { echoed: body, path } };
  });
  const env = { ML_INFERENCE_URL: mock.url, ASR_INFERENCE_URL: mock.url };
  api = await startApi({ env });
  shell = await startShell({ upstream: api.baseUrl, env });

  const [row] = await queryJson(
    `SELECT s.id, s.learner_id FROM recitation_sessions s
     JOIN consent_records c ON c.id = s.consent_record_id
     WHERE s.tenant_id = $1 ORDER BY s.started_at DESC LIMIT 1`,
    [TENANT],
  );
  assert.ok(row, "this suite needs a session with a linked consent record");
  sessionId = row.id;
  learnerId = row.learner_id;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
  await mock?.stop();
});

const ML_PATH = "/v1/ml/alignments:predict";

const mlProbe = (body, extra = {}) => ({
  path: ML_PATH,
  method: "POST",
  role: "learner",
  userId: learnerId,
  body,
  ...extra,
});

// ── the three overwrites ───────────────────────────────────────────────────────────────────────

test("the forwarded tenantId is the ACTOR's, never the client's claim", async () => {
  received.length = 0;
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "ml predict with a forged tenantId",
    probeFor: () => mlProbe({ tenantId: "tenant-somewhere-else", words: [] }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);

  // Observed at the UPSTREAM, not inferred from the response: this is the only place the overwrite
  // is visible, and it is the whole point of the route.
  assert.ok(received.length >= 2, "both implementations must have called the mock");
  for (const r of received) {
    assert.equal(
      r.body.tenantId,
      TENANT,
      "a learner authenticated for one tenant must not be able to make the ML service write " +
        "under another tenant's namespace",
    );
  }
});

test("the forwarded consent is the STORED record, never the client's claim", async () => {
  received.length = 0;
  const stored = await queryJson(
    `SELECT c.guardian_approved, c.external_asr_processing, c.audio_retention
     FROM recitation_sessions s JOIN consent_records c ON c.id = s.consent_record_id
     WHERE s.id = $1`,
    [sessionId],
  );

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "ml predict with forged consent",
    probeFor: () =>
      mlProbe({
        sessionId,
        consent: { guardianApproved: true, externalAsrProcessing: true, audioRetention: "training-opt-in" },
      }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);

  for (const r of received) {
    assert.deepEqual(
      r.body.consent,
      {
        guardianApproved: stored[0].guardian_approved,
        externalAsrProcessing: stored[0].external_asr_processing,
        audioRetention: stored[0].audio_retention,
      },
      "the ML service gates child-safety and external-ASR on this object; a client that can set " +
        "it can claim an approval it never gave",
    );
  }
});

test("an unapproved modelVersion is refused, not silently downgraded", async () => {
  for (const modelVersion of ["ml-aligner-v9.9-experimental", "", "ML-ALIGNER-V0.2"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `modelVersion ${JSON.stringify(modelVersion)}`,
      probeFor: () => mlProbe({ modelVersion, words: [] }),
      normalize: (b) => b,
    });
    if (modelVersion === "") {
      // An empty string is still a string, so it is checked and refused like any other unapproved
      // value. Asserted rather than assumed — `filter(|s| !APPROVED.contains(s))` does not special-case it.
      assert.equal(s.status, 400);
    } else {
      assert.equal(s.status, 400, `${modelVersion} must be refused`);
      assert.match(s.body.error, /not approved for production use/);
    }
  }
});

test("the APPROVED model passes through", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "approved model",
    probeFor: () => mlProbe({ modelVersion: "ml-aligner-v0.2", words: [] }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);
});

// ── session ownership ──────────────────────────────────────────────────────────────────────────

test("an unknown sessionId is 403, NOT 404 — the same answer as someone else's", async () => {
  // Identical answers mean this cannot be used to discover which session ids exist in the tenant.
  const { shell: unknown } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "ml predict against an unknown session",
    probeFor: () => mlProbe({ sessionId: "session-does-not-exist" }),
    normalize: (b) => b,
  });
  assert.equal(unknown.status, 403);

  const { shell: notMine } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "ml predict against another learner's session",
    probeFor: () => mlProbe({ sessionId }, { userId: "learner-someone-else" }),
    normalize: (b) => b,
  });
  assert.equal(notMine.status, 403, "a learner must not borrow another learner's stored consent");
});

test("admin/ops MAY analyse any in-tenant session", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "admin analyses someone else's session",
    probeFor: () => ({ path: ML_PATH, method: "POST", role: "admin", body: { sessionId } }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);
});

// ── body and upstream failure shapes ───────────────────────────────────────────────────────────

test("a non-object body is 400 with the transcribed message", async () => {
  for (const body of [[], "a string", 42, null]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `ml body ${JSON.stringify(body)}`,
      probeFor: () => mlProbe(body),
      normalize: () => null, // serde's 422 text is a recorded divergence; compare the STATUS
    });
    assert.ok([400, 422].includes(s.status), `${JSON.stringify(body)} -> ${s.status}`);
  }
});

test("an unauthenticated request never reaches the upstream", async () => {
  received.length = 0;
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "unauthenticated ml predict",
    probeFor: () => ({ path: ML_PATH, method: "POST", tenant: null, body: { words: [] } }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 401);
  assert.equal(received.length, 0, "audio must not leave before the caller is authenticated");
});

test("the ASR routes forward the body UNCHANGED and add the ASR key", async () => {
  received.length = 0;
  for (const path of ["/v1/asr/transcribe", "/v1/asr/force-align"]) {
    const body = { audioBase64: "AAAA", audioFormat: "wav", language: "ar", wordTimestamps: true };
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `asr ${path}`,
      probeFor: () => ({ path, method: "POST", role: "learner", userId: learnerId, body }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 200, s.text);
  }
  // No tenantId is injected here, and that is deliberate: transcribe/force-align perform no
  // tenant-scoped writes, so authentication alone is the control.
  for (const r of received) {
    assert.equal(r.body.tenantId, undefined, "the ASR body is forwarded unchanged");
    assert.equal(r.body.audioFormat, "wav");
  }
});

/**
 * The router hazard.
 *
 * `/v1/ml/alignments:predict` has a colon MID-SEGMENT, and Fastify's router reads `:name` as a
 * parameter. A naive registration therefore also matches `/v1/ml/alignmentsANYTHING` — serving a
 * path the contract never mentions, with the real handler.
 *
 * Rust's axum route is a literal, so it 404s. Both must agree.
 */
test("a near-miss path is NOT captured by the colon in the route", async () => {
  for (const path of [
    "/v1/ml/alignmentsXYZ",
    "/v1/ml/alignments",
    "/v1/ml/tajweed-findingsXYZ",
    "/v1/ml/alignments:predictX",
  ]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `near-miss ${path}`,
      probeFor: () => ({ path, method: "POST", role: "learner", userId: learnerId, body: {} }),
      normalize: (b) => b,
    });
    assert.equal(
      s.status,
      404,
      `${path} must not be served — a mid-segment colon read as a parameter would capture it`,
    );
  }
});

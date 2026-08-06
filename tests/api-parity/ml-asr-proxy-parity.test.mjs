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

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "POST /v1/ml/alignments:predict,POST /v1/ml/tajweed-findings:predict,POST /v1/asr/transcribe,POST /v1/asr/force-align";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;
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
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { ...env, NODE_API_PORTED: PORTED } });

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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "approved model",
    probeFor: () => mlProbe({ modelVersion: "ml-aligner-v0.2", words: [] }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);
});

// ── session ownership ──────────────────────────────────────────────────────────────────────────

test("an unknown sessionId is 403, NOT 404 — the same answer as someone else's", async () => {
  // Identical answers mean this cannot be used to discover which session ids exist in the tenant.
  const { shell: unknown } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "ml predict against an unknown session",
    probeFor: () => mlProbe({ sessionId: "session-does-not-exist" }),
    normalize: (b) => b,
  });
  assert.equal(unknown.status, 403);

  const { shell: notMine } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "ml predict against another learner's session",
    probeFor: () => mlProbe({ sessionId }, { userId: "learner-someone-else" }),
    normalize: (b) => b,
  });
  assert.equal(notMine.status, 403, "a learner must not borrow another learner's stored consent");
});

test("admin/ops MAY analyse any in-tenant session", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "admin analyses someone else's session",
    probeFor: () => ({ path: ML_PATH, method: "POST", role: "admin", body: { sessionId } }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);
});

// ── body and upstream failure shapes ───────────────────────────────────────────────────────────

test("a non-object body is 400 with the transcribed message", async () => {
  for (const body of [[], "a string", 42, null]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `ml body ${JSON.stringify(body)}`,
      probeFor: () => mlProbe(body),
      normalize: () => null, // serde's 422 text is a recorded divergence; compare the STATUS
    });
    assert.ok([400, 422].includes(s.status), `${JSON.stringify(body)} -> ${s.status}`);
  }
});

test("an unauthenticated request never reaches the upstream", async () => {
  received.length = 0;
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

// ── P5.3 — a trace must survive the service boundary ─────────────────────────────────────────────
//
// Both services audit a trace id. platform-api takes it from `x-trace-id` and writes it into
// `audit_events.metadata.trace_id`; ml-inference takes it from `requestBody.traceId` and writes it
// into its own JSONL audit log. Measured before this test existed, the proxy forwarded:
//
//     content-type, x-ml-api-key, content-length
//
// and nothing else. No trace in the header, none in the body. So platform-api recorded the caller's
// trace, ml-inference recorded null, and the two audit trails could not be joined: "which ML call
// produced this finding" had no answer, on the one path where a learner's audio meets a model.
//
// The trace the SERVER saw is authoritative, not a `traceId` the caller happens to put in the body —
// the same reasoning the proxy already applies to `tenantId`, which it overwrites rather than trusts.
const TRACE_PROXIED_ROUTES = [
  "/v1/ml/alignments:predict",
  "/v1/ml/tajweed-findings:predict",
  "/v1/asr/transcribe",
  "/v1/asr/force-align",
];

test("the caller's trace reaches the upstream service on every proxied route", async () => {
  for (const path of TRACE_PROXIED_ROUTES) {
    for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
      received.length = 0;
      const trace = `trace-${path.replace(/\W/g, "")}-${impl}`;

      await request(base, path, {
        method: "POST",
        role: "teacher",
        headers: { "x-trace-id": trace },
        // No sessionId: the consent lookup would refuse before the forward, and this test is about
        // what crosses the boundary, not about consent.
        body: { quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" } },
      });

      const forwarded = received.at(-1);
      assert.ok(forwarded, `${impl}: ${path} never reached the upstream at all`);
      assert.equal(
        forwarded.body?.traceId,
        trace,
        `${impl}: ${path} forwarded no trace — ml-inference audits null while platform-api audits ` +
          `${trace}, and the two trails cannot be joined`,
      );
    }
  }
});

test("a caller cannot forge the trace the upstream records", async () => {
  // `traceId` in the body is caller-controlled. The header is what platform-api audits, so if the
  // body won, a caller could make the two services disagree about their own audit trail — the exact
  // thing the proxy already refuses to allow for `tenantId`.
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    received.length = 0;
    await request(base, "/v1/ml/tajweed-findings:predict", {
      method: "POST",
      role: "teacher",
      headers: { "x-trace-id": "trace-from-the-header" },
      body: {
        traceId: "trace-the-caller-made-up",
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
      },
    });
    assert.equal(
      received.at(-1)?.body?.traceId,
      "trace-from-the-header",
      `${impl}: a body-supplied traceId overrode the one the server saw`,
    );
  }
});

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

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";

import { assertABMutating } from "./lib/ab.mjs";
import {
  DATABASE_URL,
  TENANT,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  startShell,
} from "./lib/harness.mjs";

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
let attributionFault;
let workerDb;
let workerLoop;
let workerRunning = false;

before(async () => {
  received = [];
  attributionFault = null;
  const respondInference = ({ path, body }) => {
    received.push({ path, body });
    // Echo, so the test can see exactly what the proxy forwarded, while carrying the strict
    // server-authored attribution every model-producing route now requires.
    const component = path.includes("force-align")
      ? "forced-aligner"
      : path.includes("transcribe")
        ? "asr"
        : "quran-aligner";
    const implementationId = `declared-${component}-fixture`;
    const response = {
      status: 200,
      body: {
        echoed: body,
        modelAttribution: {
          schemaVersion: 1,
          primaryComponent: component,
          components: [
            {
              component,
              status: "active",
              implementationId,
              artifactDigest: `sha256:${"a".repeat(64)}`,
              datasetVersion: "declared-fixture",
              analysisBasis: component === "quran-aligner" ? "quran-constrained" : "acoustic",
              calibratorId: null,
            },
          ],
        },
        modelVersion: implementationId,
        path,
      },
    };
    if (path.includes("tajweed-findings")) {
      response.body.annotations = [];
      response.body.findings = [];
      response.body.sessionId = body.sessionId;
    }
    if (attributionFault === "missing") {
      delete response.body.modelAttribution;
    } else if (attributionFault === "unknown-component") {
      response.body.modelAttribution.components[0].component = "client-chosen-aligner";
    } else if (attributionFault === "malformed-digest") {
      response.body.modelAttribution.components[0].artifactDigest = "sha256:not-a-digest";
    } else if (attributionFault === "legacy-mismatch") {
      response.body.modelVersion = "different-from-primary";
    }
    return response;
  };
  mock = await startMockUpstream(respondInference);

  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("session evaluation must not run alignment"),
    transcribeSession: async () => assert.fail("session evaluation must not run transcription"),
    async predictTajweed(body, deadline) {
      deadline.throwIfExpired();
      return respondInference({ path: "/v1/tajweed-findings:predict", body }).body;
    },
  });
  workerDb = createDb(DATABASE_URL);
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "ml-asr-proxy-parity-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      if (!sessionId) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind = 'session.evaluate'
            AND subject_id = ${sessionId}
            AND status IN ('queued', 'retry')
            AND available_at <= now()
          ORDER BY priority DESC, created_at, id
          LIMIT 1`;
        return row?.id ?? null;
      });
      if (jobId === null) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await workerRuntime.runOne(TENANT, { jobId });
      }
    }
  })();

  const env = { ML_INFERENCE_URL: mock.url, ASR_INFERENCE_URL: mock.url };
  api = await startApi({ env });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { ...env, NODE_API_PORTED: PORTED } });

  // Pick a session this suite can actually USE, not merely the newest one in the tenant.
  //
  // This query used to be `ORDER BY s.started_at DESC LIMIT 1` with no other constraint, so it took
  // whatever session happened to be most recent — which, in practice, meant a row leaked by some
  // other parity suite that never cleaned up. That was invisible while the shared database
  // accumulated ~1,700 sessions per gate run. The moment those suites began removing their own rows,
  // the newest survivor turned out to be a session whose passage has no canonical words, and
  // "tajweed forwarding replaces client references..." failed with `0 !== 3` two hundred lines below
  // — in a file that had not been touched.
  //
  // The dependency was always there; the leak was hiding it. `EXISTS` states the requirement the
  // suite actually has, so the selection can no longer succeed and then fail later.
  const [row] = await queryJson(
    `SELECT s.id, s.learner_id FROM recitation_sessions s
     JOIN consent_records c ON c.id = s.consent_record_id
     WHERE s.tenant_id = $1
       AND EXISTS (
         SELECT 1 FROM canonical_words cw
           JOIN canonical_ayahs ca ON ca.id = cw.ayah_id
          WHERE ca.surah_number = (s.quran_ref->>'surahNumber')::int
            AND ca.ayah_number BETWEEN (s.quran_ref->>'ayahStart')::int
                                   AND (s.quran_ref->>'ayahEnd')::int
       )
     ORDER BY s.started_at DESC LIMIT 1`,
    [TENANT],
  );
  assert.ok(
    row,
    "this suite needs a session with a linked consent record whose passage has canonical words",
  );
  sessionId = row.id;
  learnerId = row.learner_id;
});

after(async () => {
  let workerFailure = null;
  workerRunning = false;
  try {
    await workerLoop;
  } catch (error) {
    workerFailure = error;
  }
  await workerDb?.end();
  await shell?.stop();
  await api?.stop();
  await mock?.stop();
  if (workerFailure) throw workerFailure;
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

test("every client-supplied modelVersion is refused, including the former allowlisted value", async () => {
  for (const modelVersion of ["ml-aligner-v9.9-experimental", "", "ML-ALIGNER-V0.2", "ml-aligner-v0.2"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `modelVersion ${JSON.stringify(modelVersion)}`,
      probeFor: () => mlProbe({ modelVersion, words: [] }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 400, `${modelVersion} must be refused`);
    assert.match(s.body.error, /server-selected.*must not be supplied/);
  }
});

test("public callers cannot inject transcript evidence into the server-derived path", async () => {
  for (const [field, value] of [
    ["learnerId", "client-forged-learner"],
    ["acousticSegments", [{ wordId: "1:1:1", startMs: 0, endMs: 300 }]],
    ["recognizedTokens", [{ text: "بسم", startMs: 0, endMs: 300, confidence: 1 }]],
    ["transcriptModelAttribution", {
      schemaVersion: 1,
      primaryComponent: "asr",
      components: [{
        component: "asr",
        status: "active",
        implementationId: "client-invented-asr",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        datasetVersion: "client-invented-data",
        analysisBasis: "acoustic",
        calibratorId: null,
      }],
    }],
  ]) {
    received.length = 0;
    const { shell: s, api: r } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `client-supplied ${field}`,
      probeFor: () => mlProbe({ sessionId, [field]: value }),
      normalize: (body) => body,
    });
    assert.equal(s.status, 400, s.text);
    assert.equal(r.status, 400, r.text);
    assert.match(s.body.error, new RegExp(`${field}.*server-derived.*must not be supplied`));
    assert.equal(received.length, 0, "neither public API may forward client-invented evidence");
  }
});


test("tajweed forwarding replaces client references with stored session identity and measured spans", async () => {
  const suffix = globalThis.crypto.randomUUID();
  const auditId = `audit-w110-${suffix}`;
  const runId = `run-w110-${suffix}`;
  const alignmentIds = [
    `alignment-w110-measured-${suffix}`,
    `alignment-w110-missed-${suffix}`,
    `alignment-w110-client-${suffix}`,
  ];
  const [stored] = await queryJson(
    `SELECT learner_id, quran_ref, source_checksum, model_version_id
       FROM recitation_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, TENANT],
  );
  const referenceWords = await queryJson(
    `SELECT cw.id
       FROM canonical_words cw
       JOIN canonical_ayahs ca ON ca.id = cw.ayah_id
       WHERE ca.surah_number = ($1::jsonb->>'surahNumber')::int
         AND ca.ayah_number BETWEEN ($1::jsonb->>'ayahStart')::int
                                AND ($1::jsonb->>'ayahEnd')::int
       ORDER BY ca.ayah_number, cw.word_index
       LIMIT 3`,
    [JSON.stringify(stored.quran_ref)],
  );
  assert.equal(referenceWords.length, 3, "the session passage needs three canonical test words");
  const [runtimeModel] = await queryJson(
    `SELECT id FROM model_versions WHERE kind = 'alignment'
       ORDER BY runtime_selected DESC, id LIMIT 1`,
  );

  try {
    await queryJson(
      `INSERT INTO audit_events
         (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
       VALUES ($1, $2, $3, 'test.acoustic-context', 'recitation_session', $4, '{}'::jsonb)`,
      [auditId, TENANT, learnerId, sessionId],
    );
    await queryJson(
      `INSERT INTO alignment_runs
         (id, tenant_id, session_id, model_version_id, dataset_version, latency_ms,
          evidence_ids, consent_snapshot, audit_event_id, transcript_source, model_attribution)
       VALUES ($1, $2, $3, $4, 'declared-test-fixture', 1,
               '[]'::jsonb, '{}'::jsonb, $5, 'server-derived', '{}'::jsonb)`,
      [runId, TENANT, sessionId, runtimeModel.id, auditId],
    );
    await queryJson(
      `INSERT INTO word_alignments
         (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence,
          status, model_version_id, audit_event_id, transcript_source, alignment_run_id)
       VALUES
         ($1, $4, $5, $6, 'declared-test-fixture', 100, 500, 0.8,
          'matched', $7, $8, 'server-derived', $9),
         ($2, $4, $5, $10, 'declared-test-fixture', 600, 900, 0.8,
          'missed', $7, $8, 'server-derived', $9),
         ($3, $4, $5, $11, 'declared-test-fixture', 1000, 1300, 0.8,
          'matched', $7, $8, 'client-reported', NULL)`,
      [
        alignmentIds[0],
        alignmentIds[1],
        alignmentIds[2],
        TENANT,
        sessionId,
        referenceWords[0].id,
        runtimeModel.id,
        auditId,
        runId,
        referenceWords[1].id,
        referenceWords[2].id,
      ],
    );

    received.length = 0;
    const { shell: node } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: "tajweed stored acoustic context",
      probeFor: () => ({
        ...mlProbe(
          {
            sessionId,
            quranRef: { surahNumber: 114, ayahStart: 1, ayahEnd: 1, display: "forged" },
            sourceChecksum: "forged-checksum",
          },
          { path: "/v1/ml/tajweed-findings:predict" },
        ),
      }),
      normalize: (value) => value,
    });
    assert.equal(node.status, 200, node.text);

    const calls = received.filter((entry) => entry.path.includes("tajweed-findings"));
    assert.ok(calls.length >= 2, "both implementations must call the Tajweed upstream");
    for (const call of calls) {
      assert.equal(call.body.learnerId, stored.learner_id);
      assert.deepEqual(call.body.quranRef, stored.quran_ref);
      assert.equal(call.body.sourceChecksum, stored.source_checksum);
      assert.deepEqual(call.body.acousticSegments, [
        { wordId: referenceWords[0].id, startMs: 100, endMs: 500 },
      ]);
    }
  } finally {
    await queryJson(
      `DELETE FROM word_alignments WHERE id IN ($1, $2, $3)`,
      alignmentIds,
    );
    await queryJson(`DELETE FROM alignment_runs WHERE id = $1`, [runId]);
    await queryJson(`DELETE FROM audit_events WHERE id = $1`, [auditId]);
  }
})

test("an absent model identity passes through and the producer authors the response", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "server-selected model",
    probeFor: () => mlProbe({ words: [] }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.body.modelAttribution.primaryComponent, "quran-aligner");
  assert.equal(s.body.modelVersion, s.body.modelAttribution.components[0].implementationId);
});

test("missing, unknown, malformed, or mismatched producer attribution fails closed", async () => {
  for (const fault of ["missing", "unknown-component", "malformed-digest", "legacy-mismatch"]) {
    attributionFault = fault;
    const { shell: s, api: r } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `producer attribution ${fault}`,
      probeFor: () => mlProbe({ words: [] }),
      normalize: (body) => body,
    });
    assert.equal(s.status, 502, `${fault}: Node accepted an untraceable producer response`);
    assert.equal(r.status, 502, `${fault}: Rust accepted an untraceable producer response`);
    assert.equal(s.body.error, "ML service returned invalid model attribution");
    assert.equal(r.body.error, "ML service returned invalid model attribution");
  }
  attributionFault = null;
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

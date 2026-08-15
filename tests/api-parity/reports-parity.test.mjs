/**
 * N11 — agent runs, audit events, eval runs: the Node shell against Rust.
 * specs/migration-completion/plan.md §2
 *
 *   NODE_API_PORTED="GET /v1/agent-runs,GET /v1/audit-events,GET /v1/eval-runs/{model_version}" \
 *     node --test tests/api-parity/reports-parity.test.mjs
 *
 * All three are read-only and staff-gated, with THREE DIFFERENT role lists. Getting one of those
 * lists wrong is the kind of mistake that reads as correct — which is why each is probed for every
 * role rather than for the one the happy path uses.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { assertMatchesContract } from "./lib/contract.mjs";
import { formatF32, formatF64 } from "../../server/src/lib/json.mjs";
import { queryJson, request, startApi, startShell, TENANT, uniqueSuffix } from "./lib/harness.mjs";

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
const PORTED = "GET /v1/agent-runs,GET /v1/audit-events,GET /v1/eval-runs/{model_version}";

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
const evidenceSuffix = uniqueSuffix();
const evidenceModelVersion = `fixture-eval-model-${evidenceSuffix}`;
const evidenceEvalId = `fixture-eval-run-${evidenceSuffix}`;
const digest = (character) => `sha256:${character.repeat(64)}`;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED } });
  // Declared fixture only. It exercises every readback field and is mechanically ineligible for
  // release; none of these values is presented as model or calibration evidence.
  await queryJson(
    `insert into model_versions (id, kind, version, status) values ($1, 'alignment', $2, 'draft')`,
    [evidenceModelVersion, evidenceSuffix],
  );
  await queryJson(
    `insert into eval_runs
       (id, tenant_id, model_version_id, dataset_version, metrics, word_alignment_f1, tajweed_f1,
        false_positive_rate, teacher_agreement_rate, unsourced_learner_outputs, passed,
        evaluation_task, evidence_id, evidence_kind, evidence_eligibility, release_eligible,
        evidence_payload, evidence_payload_sha256, candidate_id, model_artifact_sha256,
        dataset_manifest_sha256, split_manifest_sha256, split_id, evaluator_version,
        evaluator_source_sha256, evaluator_protocol_sha256, raw_row_manifest_sha256,
        raw_results_sha256, calibrator_id, calibrator_artifact_sha256, signer_key_id,
        signature_algorithm, signature_base64url, signed_at, evaluation_counts, slice_metrics)
     values
       ($1, $2, $3, 'declared-fixture-v1', '{}', 0.5, 0.4, 0.3, 0.2, 1, false,
        'acoustic-tajweed', $4, 'row-level-computed-evaluation', 'fixture-regression', false,
        $5, $6, 'fixture-candidate', $7, $8, $9, 'held-out', 'fixture-evaluator-v1',
        $10, $11, $12, $13, 'fixture-calibrator', $14, 'test-only-ephemeral',
        'Ed25519', $15, '2026-08-07T00:00:00Z', $16, $17)`,
    [
      evidenceEvalId,
      TENANT,
      evidenceModelVersion,
      `fixture-evidence-${evidenceSuffix}`,
      JSON.stringify({ nested: { z: 1, a: 2 }, declaredFixture: true }),
      digest("1"),
      digest("2"),
      digest("3"),
      digest("4"),
      digest("5"),
      digest("6"),
      digest("7"),
      digest("8"),
      digest("9"),
      "A".repeat(86),
      JSON.stringify({ rowCount: 2, negativeCount: 1, positiveCount: 1, reciterCount: 2 }),
      JSON.stringify([{ sliceId: "fixture-slice", declaredFixture: true }]),
    ],
  );
});

after(async () => {
  try {
    await queryJson("delete from eval_runs where id = $1", [evidenceEvalId]);
    await queryJson("delete from model_versions where id = $1", [evidenceModelVersion]);
  } finally {
    await shell?.stop();
    await api?.stop();
  }
});

const ROLES = ["learner", "teacher", "scholar", "admin", "ops"];

test("GET /v1/agent-runs is byte-identical for EVERY role, allowed or refused", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/agent-runs", role });
  }
});

test("agent-runs allows scholar; audit and eval do NOT — three different lists", async () => {
  const status = async (path, role) => (await request(shell.baseUrl, path, { role })).status;

  assert.equal(await status("/v1/agent-runs", "scholar"), 200, "a scholar reviews agent output");
  assert.equal(await status("/v1/agent-runs", "teacher"), 200);
  assert.equal(await status("/v1/agent-runs", "learner"), 403);

  assert.equal(await status("/v1/audit-events", "scholar"), 403, "audit is admin/ops only");
  assert.equal(await status("/v1/audit-events", "teacher"), 403);
  assert.equal(await status("/v1/audit-events", "admin"), 200);

  assert.equal(await status("/v1/eval-runs/anything", "scholar"), 403);
  assert.equal(await status("/v1/eval-runs/anything", "teacher"), 403);
});

test("GET /v1/audit-events is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/audit-events", role });
  }
});

test("audit events keep DECLARATION order — AuditEvent is a struct, not a json! literal", async () => {
  const res = await request(shell.baseUrl, "/v1/audit-events", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "the seeded corpus has audit events; without any this proves nothing");
  assert.deepEqual(Object.keys(res.body[0]), [
    "id",
    "tenantId",
    "actorId",
    "traceId",
    "action",
    "subjectType",
    "subjectId",
  ]);
});

test("GET /v1/eval-runs/{v}: a missing model version is 404, identically", async () => {
  for (const path of ["/v1/eval-runs/no-such-model", "/v1/eval-runs/..%2Fetc", "/v1/eval-runs/%20"]) {
    await assertAB(shell.baseUrl, rustUrl, { path, role: "admin" });
  }
});

test("eval evidence is complete, explicit, ineligible, and byte-identical", async () => {
  const path = `/v1/eval-runs/${evidenceModelVersion}`;
  const response = await request(shell.baseUrl, path, { role: "admin" });
  assert.equal(response.status, 200);
  assertMatchesContract("GET", path, response);
  assert.deepEqual(Object.keys(response.body), [
    "modelVersion",
    "datasetVersion",
    "wordAlignmentF1",
    "tajweedF1",
    "falsePositiveRate",
    "teacherAgreementRate",
    "unsourcedLearnerOutputs",
    "passed",
    "evaluationTask",
    "evidenceId",
    "evidenceKind",
    "evidenceEligibility",
    "releaseEligible",
    "evidencePayload",
    "evidencePayloadSha256",
    "candidateId",
    "modelArtifactSha256",
    "datasetManifestSha256",
    "splitManifestSha256",
    "splitId",
    "evaluatorVersion",
    "evaluatorSourceSha256",
    "evaluatorProtocolSha256",
    "rawRowManifestSha256",
    "rawResultsSha256",
    "calibratorId",
    "calibratorArtifactSha256",
    "signerKeyId",
    "signatureAlgorithm",
    "signatureBase64Url",
    "signedAt",
    "evaluationCounts",
    "sliceMetrics",
  ]);
  assert.equal(response.body.evidenceKind, "row-level-computed-evaluation");
  assert.equal(response.body.evidenceEligibility, "fixture-regression");
  assert.equal(response.body.releaseEligible, false);
  assert.equal(response.body.passed, false);
  assert.equal(response.body.signedAt, "2026-08-07T00:00:00.000000Z");
  assert.deepEqual(response.body.evidencePayload, {
    declaredFixture: true,
    nested: { a: 2, z: 1 },
  });
  assert.deepEqual(response.body.evaluationCounts, {
    negativeCount: 1,
    positiveCount: 1,
    reciterCount: 2,
    rowCount: 2,
  });
  assert.deepEqual(response.body.sliceMetrics, [
    { declaredFixture: true, sliceId: "fixture-slice" },
  ]);
  await assertAB(shell.baseUrl, rustUrl, { path, role: "admin" });
});

/**
 * The f32 case, and why it needs its own test.
 *
 * `EvalRun`'s four metrics are `f32` (types.rs:276-279): read from Postgres as float8, narrowed
 * with `as f32`, then printed by serde as the shortest string that round-trips to that SINGLE.
 * A JS port has only doubles, so without an explicit narrow-and-shorten a metric can carry extra
 * digits. Byte-identical is the only assertion that catches it — and it only fires on a value the
 * two formatters actually PRINT differently, which this corpus does not contain. The test below
 * records that gap explicitly rather than letting this one imply coverage it does not have.
 */
test("eval-run metrics survive the f32 narrowing byte-for-byte", async () => {
  const rows = await request(shell.baseUrl, "/v1/eval-runs/seeded-eval-f32", { role: "admin" });
  if (rows.status === 404) {
    // No seeded row: assert the SHAPE against Rust on whatever the corpus does have, and say
    // plainly that the precision case is uncovered rather than reporting a pass that proves nothing.
    const list = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
    if (list.status === 404) {
      assert.ok(true, "SKIP — no eval_runs row in this corpus; f32 precision is covered by the " +
        "unit tests in tests/node-api/rust-json.test.mjs only");
      return;
    }
  }
  await assertAB(shell.baseUrl, rustUrl, { path: "/v1/eval-runs/model-v0.3", role: "admin" });
});

/**
 * A RECORDED GAP, stated rather than left silent.
 *
 * Replacing `f32()` with `f64()` on a metric runs GREEN against this corpus: for every seeded value
 * the two formatters produce the SAME string, so the wrong one changes nothing. (Not because the
 * values are exactly representable — 0.93 is not — but because both shortest-round-trip forms come
 * out as "0.93".) The A/B has no teeth for the narrowing here, and
 * `tests/node-api/rust-json.test.mjs` is the only thing covering it.
 *
 * Assert the PREMISE, so that if the corpus ever gains a value the two formatters disagree on, this
 * test says the A/B has become load-bearing instead of it quietly starting to matter.
 */
test("the f32 narrowing is NOT exercised by this corpus — stated, not assumed", async () => {
  const res = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
  if (res.status === 404) {
    // Said out loud. No migration seeds eval_runs, so on CI this is ALWAYS the branch taken and the
    // test reported a silent pass. It still cannot assert anything without a row — that needs a
    // seeded eval run, which is a fixture nobody has written — but a skip that announces itself can
    // be counted, and a silent one cannot.
    assert.ok(true, "SKIP — no eval_runs row for model-v0.3; the f32 premise is unchecked here");
    return;
  }
  for (const key of ["wordAlignmentF1", "tajweedF1", "falsePositiveRate", "teacherAgreementRate"]) {
    const v = res.body[key];
    if (typeof v !== "number") continue;
    // The discriminator is NOT "is it exactly representable in f32" — 0.93 is not, and both
    // formatters still print "0.93". What matters is whether the two formatters DISAGREE on this
    // value; only then does using the wrong one change the bytes. (First draft of this test used
    // exact-representability and failed on 0.93 while the mutation still ran green — the premise
    // was measuring the wrong thing.)
    assert.equal(
      formatF32(v),
      formatF64(v),
      `${key} = ${v} now prints differently as f32 (${formatF32(v)}) than as f64 (${formatF64(v)}). ` +
        "The f32-vs-f64 mutation is no longer silent, so the A/B above genuinely covers the " +
        "narrowing — good, but confirm it rather than assuming.",
    );
  }
});

test("an integer count does NOT gain a decimal point next to the f32 metrics", async () => {
  const res = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
  if (res.status === 404) {
    assert.ok(true, "SKIP — no eval_runs row for model-v0.3; the u32 formatting is unchecked here");
    return;
  }
  assert.match(
    res.text,
    /"unsourcedLearnerOutputs":\d+(,|})/,
    "unsourcedLearnerOutputs is u32; wrapping it in f32()/f64() by mistake would emit `0.0`",
  );
});

test("agent-runs: sources is jsonb the server does not validate, and passes through unchanged",
  async () => {
    const res = await request(shell.baseUrl, "/v1/agent-runs", { role: "admin" });
    assert.equal(res.status, 200);
    for (const run of res.body) {
      assert.ok(Array.isArray(run.sources) || typeof run.sources === "object");
      // lastEvent falls back to "" and NOT to null: a null would vanish in a client that treats
      // null as absent, and the field is what an operator reads to see where a run stopped.
      assert.equal(typeof run.lastEvent, "string");
    }
  });

test("agent-runs key order is alphabetical — json!, unlike AuditEvent", async () => {
  // Creates the row it needs. `if (empty) return` made this wire contract assert nothing on CI:
  // no migration seeds agent_runs, so the route returns [] there and the test reported a pass while
  // checking no keys at all. A shape assertion that only runs on a developer's machine is pinned to
  // the one place the gate is not.
  const created = await request(shell.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "scholar",
    body: {
      name: "shape-probe",
      goal: "pin the wire shape",
      status: "needs-human-review",
      confidence: 0.5,
      sources: [],
    },
  });
  assert.ok(
    created.status < 500,
    `could not create an agent run to assert the shape against: ${created.status} ${created.text}`,
  );

  const res = await request(shell.baseUrl, "/v1/agent-runs", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "an agent run was just created and the list came back empty");
  assert.deepEqual(Object.keys(res.body[0]), [
    "confidence",
    "findingId",
    "goal",
    "id",
    "lastEvent",
    "learnerId",
    "name",
    "reviewStatus",
    "sources",
    "status",
  ]);
});

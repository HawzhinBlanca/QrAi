/**
 * POST /v1/recitation-sessions/{id}/finalize — server-derived audio evidence only.
 *
 * The shell is explicitly started with the finalizer route. If local registration disappears,
 * startup fails; this suite can never silently compare Rust with a Rust proxy labelled "Node".
 *
 * integration.rs:4541 — finalize_persists_a_server_derived_alignment_and_refuses_without_consent
 * integration.rs:4609 — finalize_without_a_transcript_stores_nothing
 * integration.rs:5213 — finalize_records_chunks_the_session_never_got
 * integration.rs:5261 — a_complete_session_records_no_lost_chunks
 * integration.rs:6362 — a_finalized_session_records_a_server_derived_alignment
 * integration.rs:5200 — finalize_rolls_back_every_alignment_when_one_claimed_span_is_invalid
 * integration.rs:5250 — finalize_refuses_a_valid_producer_that_disagrees_with_the_session_model
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";

import {
  DATABASE_URL,
  TENANT,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  startShell,
} from "./lib/harness.mjs";

const PORTED = "POST /v1/recitation-sessions/{id}/finalize";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

const asrComponent = (overrides = {}) => ({
  analysisBasis: "acoustic",
  artifactDigest: DIGEST_A,
  calibratorId: null,
  component: "asr",
  datasetVersion: "declared-asr-dataset",
  implementationId: "declared-asr-fixture",
  status: "active",
  ...overrides,
});
const asrAttribution = (component = asrComponent()) => ({
  components: [component],
  primaryComponent: "asr",
  schemaVersion: 1,
});
const alignmentAttribution = (modelVersion, upstream = asrComponent()) => ({
  components: [
    upstream,
    {
      analysisBasis: "quran-constrained",
      artifactDigest: DIGEST_B,
      calibratorId: null,
      component: "quran-aligner",
      datasetVersion: "declared-quran-dataset",
      implementationId: modelVersion,
      status: "active",
    },
  ],
  primaryComponent: "quran-aligner",
  schemaVersion: 1,
});

let api;
let shell;
let mock;
let learnerId;
let workerDb;
let workerInference;
let workerLoop;
let workerRunning = false;
let mode = "happy";
const sessionModels = new Map();
const createdSessions = [];

const modelFor = (body) => sessionModels.get(body?.sessionId) ?? "quran-constrained-levenshtein@1";

function transcript(body) {
  if (
    mode === "no-transcript" ||
    body?.consent?.externalAsrProcessing !== true ||
    body?.consent?.guardianApproved !== true
  ) {
    return {
      body: {
        chunkCount: 0,
        reason: "consent-revoked-or-insufficient",
        recognizedText: [],
        transcribed: false,
      },
    };
  }
  const attribution = asrAttribution();
  return {
    body: {
      chunkCount: 3,
      missingChunkIds: mode === "gap" ? ["s-ws-0003", "s-ws-0004"] : [],
      modelAttribution: attribution,
      modelVersion: "declared-asr-fixture",
      reason: "consent-granted",
      recognizedTokens:
        mode === "empty-tokens"
          ? []
          : [
              { confidence: 0.93, endMs: 500, startMs: 0, text: "بسم" },
              { confidence: 0.9, endMs: 900, startMs: 500, text: "الله" },
            ],
      transcriptSource: "server-derived",
      transcribed: true,
    },
  };
}

function alignment(body) {
  const sessionModel = modelFor(body);
  if (mode === "non-finalizable") {
    return { body: { alignments: [], finalizable: false, nonFinalizedReason: "invalid-recognized-spans" } };
  }
  const producerModel = mode === "model-mismatch" ? "another-valid-quran-aligner@1" : sessionModel;
  const upstream =
    mode === "unrelated-attribution"
      ? asrComponent({ artifactDigest: DIGEST_C, implementationId: "unrelated-asr-fixture" })
      : asrComponent();
  const second =
    mode === "invalid-span"
      ? { confidence: 0.7, endMs: 500, heardText: "الله", startMs: 500, status: "misread", wordId: "1:1:2" }
      : mode === "unknown-word"
        ? { confidence: 0.7, endMs: 900, heardText: "الله", startMs: 500, status: "misread", wordId: "1:1:999" }
        : { confidence: 0.7, endMs: 900, heardText: "الله", startMs: 500, status: "misread", wordId: "1:1:2" };
  return {
    body: {
      alignments: [
        { confidence: 0.9, endMs: 500, heardText: "بسم", startMs: 0, status: "matched", wordId: "1:1:1" },
        second,
      ],
      datasetVersion: "declared-quran-dataset",
      evidenceId: `declared-finalize-${mode}`,
      finalizable: true,
      latencyMs: 9,
      modelAttribution: alignmentAttribution(producerModel, upstream),
      modelVersion: producerModel,
      nonFinalizedReason: null,
      sessionId: body.sessionId,
    },
  };
}

function createParityInference() {
  const calls = [];
  const inference = createInferenceRuntime({
    async transcribeSession(body, deadline) {
      calls.push({ path: "/v1/session-transcript", body });
      if (mode === "hang") {
        await new Promise((resolve, reject) => {
          const fail = () => reject(deadline.signal.reason ?? new Error("inference deadline exceeded"));
          if (deadline.signal.aborted) fail();
          else deadline.signal.addEventListener("abort", fail, { once: true });
        });
      }
      deadline.throwIfExpired();
      return transcript(body).body;
    },
    async predictAlignment(body, deadline) {
      calls.push({ path: "/v1/alignments:predict", body });
      deadline.throwIfExpired();
      return alignment(body).body;
    },
    async predictTajweed(body, deadline) {
      calls.push({ path: "/v1/tajweed-findings:predict", body });
      deadline.throwIfExpired();
      return { annotations: [], findings: [], sessionId: body.sessionId };
    },
  });
  return { calls, inference };
}

const responder = ({ path, body }) => {
  if (mode === "hang" && path === "/v1/session-transcript") return { hang: true };
  if (path === "/v1/session-transcript") return transcript(body);
  if (path === "/v1/alignments:predict") return alignment(body);
  return { status: 404, body: { error: "not found" } };
};

async function createSession(baseUrl, consentOverrides = {}) {
  const response = await request(baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      consent: {
        anonymizedLearning: false,
        audioRetention: "teacher-review",
        consentVersion: "declared-finalize-parity-v1",
        externalAsrProcessing: true,
        guardianApproved: true,
        ...consentOverrides,
      },
      language: "ckb",
      learnerId,
      mode: "guided-recite",
      practicePlanId: "declared-finalize-parity",
      quranRef: {
        ayahEnd: 7,
        ayahStart: 1,
        display: "Al-Fatihah 1:1-7",
        surahNumber: 1,
      },
      sourceChecksum: `fixture:finalize-${Date.now()}-${Math.random()}`,
    },
  });
  assert.equal(response.status, 200, response.text);
  sessionModels.set(response.body.id, response.body.modelVersion);
  createdSessions.push(response.body.id);
  return response.body.id;
}

async function cleanupSession(sessionId) {
  const [session] = await queryJson(
    "SELECT consent_record_id, audit_event_id FROM recitation_sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) return;
  await queryJson("DELETE FROM teacher_reviews WHERE finding_id IN (SELECT tf.id FROM tajweed_findings tf JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1)", [sessionId]);
  await queryJson("DELETE FROM tajweed_findings WHERE alignment_id IN (SELECT id FROM word_alignments WHERE session_id = $1)", [sessionId]);
  await queryJson("DELETE FROM word_alignments WHERE session_id = $1", [sessionId]);
  await queryJson("DELETE FROM alignment_runs WHERE session_id = $1", [sessionId]);
  await queryJson("DELETE FROM audio_chunks WHERE session_id = $1", [sessionId]);
  await queryJson("DELETE FROM realtime_session_tickets WHERE session_id = $1", [sessionId]);
  await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [sessionId]);
  await queryJson("DELETE FROM consent_records WHERE id = $1", [session.consent_record_id]);
  await queryJson(
    "DELETE FROM audit_events WHERE id = $1 OR (subject_type = 'recitation_session' AND subject_id = $2)",
    [session.audit_event_id, sessionId],
  );
}

before(async () => {
  mock = await startMockUpstream(responder);
  workerInference = createParityInference();
  workerDb = createDb(DATABASE_URL);
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference: workerInference.inference,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "session-finalize-parity-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 60_000,
    retryMaxMs: 60_000,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      const ownedSessions = [...createdSessions];
      if (ownedSessions.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind = 'session.finalize'
            AND subject_id = ANY(${ownedSessions})
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

  const env = {
    ML_API_KEY: "declared-finalize-key",
    ML_INFERENCE_URL: mock.url,
    UPSTREAM_TIMEOUT_SECS: "1",
  };
  api = await startApi({ env });
  const rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { ...env, NODE_API_PORTED: PORTED } });
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  assert.ok(learner);
  learnerId = learner.id;
});

after(async () => {
  let workerFailure = null;
  try {
    workerRunning = false;
    try {
      await workerLoop;
    } catch (error) {
      workerFailure = error;
    }
    for (const sessionId of createdSessions.reverse()) await cleanupSession(sessionId);
  } finally {
    await workerDb?.end();
    await shell?.stop();
    await api?.stop();
    await mock?.stop();
  }
  if (workerFailure) throw workerFailure;
});

test("Node and Rust persist the same server-derived run and word evidence", async () => {
  mode = "happy";
  const rustUrl = api.upstreamUrl ?? api.baseUrl;
  const outcomes = [];
  for (const [implementation, baseUrl] of [["node", shell.baseUrl], ["rust", rustUrl]]) {
    const sessionId = await createSession(baseUrl);
    mock.received.length = 0;
    workerInference.calls.length = 0;
    const response = await request(baseUrl, `/v1/recitation-sessions/${sessionId}/finalize`, {
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: {},
    });
    assert.equal(response.status, 200, `${implementation}: ${response.text}`);
    assert.equal(response.body.finalized, true);
    assert.equal(response.body.persisted, 2);
    assert.equal(response.body.lostChunkCount, 0);
    const inferenceCalls = implementation === "node"
      ? workerInference.calls
      : mock.received;
    assert.deepEqual(inferenceCalls.map((call) => call.path), [
      "/v1/session-transcript",
      "/v1/alignments:predict",
    ]);
    const alignmentCall = inferenceCalls[1].body;
    assert.equal(Object.hasOwn(alignmentCall, "recognizedText"), false);
    assert.deepEqual(alignmentCall.transcriptModelAttribution, asrAttribution());

    const rows = await queryJson(
      `SELECT wa.heard_text, wa.status, wa.transcript_source, wa.alignment_run_id,
              ar.dataset_version, ar.evidence_ids, ar.model_attribution
       FROM word_alignments wa JOIN alignment_runs ar ON ar.id = wa.alignment_run_id
       WHERE wa.session_id = $1 ORDER BY wa.start_ms`,
      [sessionId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.transcript_source === "server-derived"));
    assert.equal(new Set(rows.map((row) => row.alignment_run_id)).size, 1);
    assert.deepEqual(rows.map((row) => row.heard_text), ["بسم", "الله"]);
    assert.deepEqual(rows[0].evidence_ids, ["declared-finalize-happy"]);
    assert.deepEqual(rows[0].model_attribution, alignmentAttribution(modelFor({ sessionId })));
    outcomes.push({
      body: { ...response.body, auditEventId: "<audit>", sessionId: "<session>" },
      rows: rows.map(({ alignment_run_id: _run, ...row }) => row),
    });
  }
  assert.deepEqual(outcomes[0].body, outcomes[1].body, "Node response drifted from Rust");
  assert.deepEqual(outcomes[0].rows, outcomes[1].rows, "Node durable evidence drifted from Rust");
});

test("no consent or no transcript is a normal refusal and stores nothing", async () => {
  for (const [label, consent, selectedMode] of [
    ["consent denied", { externalAsrProcessing: false }, "happy"],
    ["no transcript", {}, "no-transcript"],
  ]) {
    mode = selectedMode;
    const sessionId = await createSession(shell.baseUrl, consent);
    const response = await request(
      shell.baseUrl,
      `/v1/recitation-sessions/${sessionId}/finalize`,
      { method: "POST", role: "learner", userId: learnerId, body: {} },
    );
    assert.equal(response.status, 200, `${label}: ${response.text}`);
    assert.deepEqual(response.body, {
      finalized: false,
      persisted: 0,
      reason: "consent-revoked-or-insufficient",
      sessionId,
    });
    const [count] = await queryJson(
      "SELECT count(*)::int AS words FROM word_alignments WHERE session_id = $1",
      [sessionId],
    );
    assert.equal(count.words, 0, `${label}: refusal stored learner-performance claims`);
  }
});

test("one invalid producer row rolls back the entire replacement and preserves prior practice", async () => {
  mode = "happy";
  const sessionId = await createSession(shell.baseUrl);
  const prior = await request(shell.baseUrl, `/v1/recitation-sessions/${sessionId}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      alignments: [
        { confidence: 0.4, endMs: 100, heardText: "prior-client-practice", startMs: 10, status: "matched", wordId: "1:1:1" },
      ],
    },
  });
  assert.equal(prior.status, 200, prior.text);

  for (const invalidMode of ["invalid-span", "unknown-word"]) {
    mode = invalidMode;
    const response = await request(
      shell.baseUrl,
      `/v1/recitation-sessions/${sessionId}/finalize`,
      { method: "POST", role: "learner", userId: learnerId, body: {} },
    );
    assert.equal(response.status, 200, `${invalidMode}: ${response.text}`);
    assert.equal(response.body.finalized, false);
    assert.equal(response.body.reason, "invalid-alignment-output");
    const rows = await queryJson(
      "SELECT heard_text, transcript_source FROM word_alignments WHERE session_id = $1",
      [sessionId],
    );
    assert.deepEqual(rows, [
      { heard_text: "prior-client-practice", transcript_source: "client-reported" },
    ]);
    const [runs] = await queryJson(
      "SELECT count(*)::int AS count FROM alignment_runs WHERE session_id = $1",
      [sessionId],
    );
    assert.equal(runs.count, 0, `${invalidMode}: rolled-back producer run survived`);
  }
});

test("model disagreement and an unrelated attribution chain fail before persistence", async () => {
  for (const [selectedMode, expectedStatus, expectedReason] of [
    ["model-mismatch", 200, "model-version-mismatch"],
    ["unrelated-attribution", 502, null],
  ]) {
    mode = selectedMode;
    const sessionId = await createSession(shell.baseUrl);
    const response = await request(
      shell.baseUrl,
      `/v1/recitation-sessions/${sessionId}/finalize`,
      { method: "POST", role: "learner", userId: learnerId, body: {} },
    );
    assert.equal(response.status, expectedStatus, `${selectedMode}: ${response.text}`);
    if (expectedReason !== null) assert.equal(response.body.reason, expectedReason);
    const [counts] = await queryJson(
      `SELECT
         (SELECT count(*) FROM word_alignments WHERE session_id = $1)::int AS words,
         (SELECT count(*) FROM alignment_runs WHERE session_id = $1)::int AS runs`,
      [sessionId],
    );
    assert.deepEqual(counts, { runs: 0, words: 0 });
  }
});

test("missing chunks are surfaced and stored without relabelling finalization as failed", async () => {
  mode = "gap";
  const sessionId = await createSession(shell.baseUrl);
  const response = await request(
    shell.baseUrl,
    `/v1/recitation-sessions/${sessionId}/finalize`,
    { method: "POST", role: "learner", userId: learnerId, body: {} },
  );
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.finalized, true);
  assert.equal(response.body.lostChunkCount, 2);
  const [session] = await queryJson(
    "SELECT lost_chunk_count FROM recitation_sessions WHERE id = $1",
    [sessionId],
  );
  assert.equal(session.lost_chunk_count, 2);
});

test("retrying finalization replaces the run atomically instead of duplicating evidence", async () => {
  mode = "happy";
  const sessionId = await createSession(shell.baseUrl);
  const runIds = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(
      shell.baseUrl,
      `/v1/recitation-sessions/${sessionId}/finalize`,
      { method: "POST", role: "learner", userId: learnerId, body: {} },
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.finalized, true);
    const rows = await queryJson(
      "SELECT alignment_run_id FROM word_alignments WHERE session_id = $1 ORDER BY start_ms",
      [sessionId],
    );
    assert.equal(rows.length, 2, `attempt ${attempt + 1} duplicated or lost words`);
    assert.equal(new Set(rows.map((row) => row.alignment_run_id)).size, 1);
    runIds.push(rows[0].alignment_run_id);
    const [runs] = await queryJson(
      "SELECT count(*)::int AS count FROM alignment_runs WHERE session_id = $1",
      [sessionId],
    );
    assert.equal(runs.count, 1, `attempt ${attempt + 1} left more than one producer run`);
  }
  assert.notEqual(runIds[0], runIds[1], "the retry reused a stale producer run document");
});

test("a hung transcript call is bounded, returns generic 502, and commits nothing", async () => {
  mode = "hang";
  const sessionId = await createSession(shell.baseUrl);
  const started = Date.now();
  const response = await request(
    shell.baseUrl,
    `/v1/recitation-sessions/${sessionId}/finalize`,
    { method: "POST", role: "learner", userId: learnerId, body: {} },
  );
  const elapsed = Date.now() - started;
  assert.equal(response.status, 502, response.text);
  assert.ok(elapsed >= 750 && elapsed < 4_000, `1s deadline returned after ${elapsed}ms`);
  assert.deepEqual(response.body, { error: "ML service unavailable" });
  const [counts] = await queryJson(
    `SELECT
       (SELECT count(*) FROM word_alignments WHERE session_id = $1)::int AS words,
       (SELECT count(*) FROM alignment_runs WHERE session_id = $1)::int AS runs`,
    [sessionId],
  );
  assert.deepEqual(counts, { runs: 0, words: 0 });
  const health = await request(shell.baseUrl, "/health");
  assert.equal(health.status, 200, "one hung finalization wedged the API");
});

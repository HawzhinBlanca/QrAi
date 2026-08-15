/**
 * One learner request, one server-authoritative trace, and no invented performance evidence. (P5.3)
 *
 *   node --test tests/observability/trace-join.test.mjs
 *
 * ── Why this exists and why the parity test was not enough ──────────────────────────────────────
 * `tests/api-parity/ml-asr-proxy-parity.test.mjs` asserts that the caller's `x-trace-id` is
 * forwarded into the ML request body. That is a claim about the WIRE. The claim anyone actually
 * relies on is about the OUTCOME: that after a learner's audio has been analysed, an operator asking
 * "which ML call produced this analysis" can answer it from what was written down.
 *
 * Those are different claims, and the wire test cannot tell them apart. ml-inference could receive
 * `traceId` and drop it on the floor; platform-api could stop writing `metadata.trace_id`; the two
 * could disagree about which session a trace belongs to. All three leave the forwarding assertion
 * green. A guard that passes for the wrong reason is the defect class this project keeps finding, and
 * writing the wire test without this one would have planted a fresh instance of it.
 *
 * So this test starts the REAL ml-inference — not the mock the parity suite uses, because a mock
 * records whatever the test tells it to and can never fail this way — issues one request, and then
 * proves the boundary for real:
 *
 *   platform-api  ->  forwards the server-seen trace and persists no performance finding
 *   ml-inference  ->  <AUDIO_STORAGE_DIR>/audit-log/<tenant>.jsonl, `traceId` per line
 *
 * Deterministic Quran-text rules are instructional annotations. They do not inspect learner audio,
 * so manufacturing a Postgres performance finding merely to preserve the former two-row join would
 * be a false provenance claim. The durable ML event and returned annotation must carry the trace,
 * while the performance table and its persistence audit must remain empty for this session.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TENANT,
  queryJson,
  request,
  reservePort,
  startApi,
  uniqueSuffix,
} from "../api-parity/lib/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ML_ENTRY = join(root, "tests/inference/lib/worker-compatibility-harness.mjs");
const ML_KEY = "trace-join-ml-key";

let ml;
let mlStderr = "";
let storageDir;
let api;
let rustUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(url, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(50);
  }
  throw new Error(`ml-inference never became healthy at ${url}\n${mlStderr}`);
}

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "trace-join-"));
  const mlPort = await reservePort();

  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (d) => {
    mlStderr += `[ml] ${d}`;
  });

  const mlUrl = `http://127.0.0.1:${mlPort}`;
  await waitForHealth(`${mlUrl}/health`);

  api = await startApi({ env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
});

after(async () => {
  await api?.stop();
  if (ml && ml.exitCode === null) {
    ml.kill("SIGTERM");
    const hard = Date.now() + 5_000;
    while (ml.exitCode === null && Date.now() < hard) await sleep(25);
    if (ml.exitCode === null) ml.kill("SIGKILL");
  }
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

/** Every audit line ml-inference durably wrote for this tenant. */
function mlAuditEvents() {
  const file = join(storageDir, "audit-log", `${TENANT}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** A real session for `learner-1`, created through the API so its consent record is the real one. */
async function createSession() {
  const learner = "learner-1";
  const res = await request(rustUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      learnerId: learner,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
      sourceChecksum: "fnv1a32:tracejoin",

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "discard",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  // 200, not 201 — the difference Phase 5's differ recorded rather than "corrected".
  assert.equal(res.status, 200, `session create failed: ${res.text}`);
  const id = res.body.id ?? res.body.sessionId;
  assert.ok(id, `no session id in ${res.text}`);

  // ── The session needs WORD ALIGNMENTS before a finding can be persisted against it ──────────────
  // `persist_tajweed_findings` returns early when the session has no alignments: "there is no
  // evidence a finding could point at". Measured the hard way — the first version of this test
  // predicted against a bare session, got 200 with 5 findings in the response, and found no audit
  // row. That was my setup being wrong, not the service: a finding with nothing to anchor to is
  // exactly what that branch refuses to store.
  const words = await queryJson(
    "SELECT id FROM canonical_words WHERE ayah_id = '1:1' ORDER BY word_index LIMIT 2",
  );
  assert.equal(words.length, 2, `need 2 canonical words from 1:1, got ${words.length}`);
  const aligned = await request(rustUrl, `/v1/recitation-sessions/${id}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      alignments: [
        { wordId: words[0].id, heardText: "x", startMs: 0, endMs: 100, confidence: 0.9, status: "matched" },
        { wordId: words[1].id, heardText: "y", startMs: 100, endMs: 200, confidence: 0.5, status: "misread" },
      ],
    },
  });
  assert.equal(aligned.status, 200, `alignment persist failed: ${aligned.text}`);
  assert.equal(aligned.body.persisted, 2, `alignments not persisted: ${aligned.text}`);

  return { learner, sessionId: id };
}

test("an operator can trace instructional analysis without a fabricated performance finding", async () => {
  const { learner, sessionId } = await createSession();

  const trace = `trace-join-${uniqueSuffix()}`;
  const predicted = await request(rustUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    userId: learner,
    headers: { "x-trace-id": trace },
    body: {
      sessionId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    },
  });
  assert.equal(predicted.status, 200, `predict failed: ${predicted.text}`);
  assert.ok(predicted.body.annotations.length > 0, "real Quran instruction produced no annotations");
  assert.deepEqual(predicted.body.findings, [], "text-only analysis invented learner findings");
  assert.equal(predicted.body.traceId, trace, "the response lost the server-seen trace");
  for (const annotation of predicted.body.annotations) {
    assert.equal(annotation.analysisBasis, "text-rule");
    assert.equal(annotation.instructional, true);
    assert.equal(annotation.traceId, trace);
    for (const forbidden of ["confidence", "severity", "reviewStatus"]) {
      assert.equal(Object.hasOwn(annotation, forbidden), false, `${forbidden} leaked into instruction`);
    }
  }

  // The platform must not create the performance-side half of the former join. There was no
  // acoustic finding to persist, so such a row would itself be fabricated evidence.
  const platformRows = await queryJson(
    `SELECT action, subject_id, metadata->>'trace_id' AS trace_id
       FROM audit_events
      WHERE metadata->>'trace_id' = $1`,
    [trace],
  );
  assert.deepEqual(
    platformRows.filter((row) => row.action === "ml.tajweed.persisted"),
    [],
    "platform-api claimed it persisted learner performance for text-only instruction",
  );
  const persistedFindings = await queryJson(
    `SELECT tf.id
       FROM tajweed_findings tf
       JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE wa.session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(persistedFindings, [], "text-only instruction created performance rows");

  // The real producer still records exactly which analysis ran for which session.
  const mlRows = mlAuditEvents().filter((e) => e.traceId === trace);
  assert.ok(
    mlRows.length > 0,
    `ml-inference recorded no audit event for trace ${trace}. ` +
      `"which ML call produced this instruction" has no answer. ` +
      `Traces it did record: ${JSON.stringify(mlAuditEvents().map((e) => e.traceId))}`,
  );

  assert.equal(
    mlRows[0].action,
    "ml.tajweed.predicted",
    "the ml-inference side of the join is not the prediction event",
  );
  assert.equal(
    mlRows[0].subjectId,
    sessionId,
    "ml-inference attributed the trace to a different session than the one requested",
  );
  assert.ok(mlRows[0].details.annotationCount > 0, "the audit omitted its instructional output count");
  assert.equal(mlRows[0].details.findingCount, 0, "the audit claimed learner-performance findings");
  assert.equal(predicted.body.auditEventId, mlRows[0].id, "the response cannot join to its ML audit");
});

test("a trace the caller invents in the body cannot displace the one the server saw", async () => {
  // The forged-trace parity test asserts what crosses the wire. This asserts what is DURABLE: the
  // caller cannot redirect the producer's audit record away from the server-observed request.
  const { learner, sessionId } = await createSession();

  const served = `trace-served-${uniqueSuffix()}`;
  const forged = `trace-forged-${uniqueSuffix()}`;
  const predicted = await request(rustUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    userId: learner,
    headers: { "x-trace-id": served },
    body: {
      traceId: forged,
      sessionId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    },
  });
  assert.equal(predicted.status, 200, `predict failed: ${predicted.text}`);

  const durable = mlAuditEvents().map((e) => e.traceId);
  assert.ok(
    durable.includes(served),
    `ml-inference did not durably record the server-seen trace ${served}; it has ${JSON.stringify(durable)}`,
  );
  assert.ok(
    !durable.includes(forged),
    `ml-inference durably recorded a caller-invented trace (${forged}), so an audit trail can be ` +
      `pointed anywhere by the party it exists to hold accountable`,
  );
});

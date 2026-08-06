/**
 * A tajweed prediction must leave something a teacher can review — in BOTH implementations.
 *
 *   node --test tests/api-parity/tajweed-persistence-effects.test.mjs
 *
 * ── Why this is not an `assertAB` probe ─────────────────────────────────────────────────────────
 * `assertAB` compares status, headers and response bytes. On this route the two implementations
 * agreed on all three and disagreed on everything that matters:
 *
 *     rust        status=200  findings in response=5  tajweed_findings=1  audit=1
 *     node shell  status=200  findings in response=5  tajweed_findings=0  audit=0
 *
 * The Node port returned the findings and stored none of them. No teacher could ever review one, and
 * there was no record that the ML call had happened at all — the exact state `persist_tajweed_findings`
 * was written to end ("Tajweed findings existed only for the length of this response until now"),
 * reintroduced by the port and invisible to the differ because the bytes matched.
 *
 * Response parity is not effect parity. A byte comparison cannot see a missing INSERT, so the
 * assertion here is against the DATABASE, per implementation, with no comparison between them: an
 * absolute expectation is the only kind that survives both sides being wrong the same way.
 *
 * ── Why the real ml-inference ───────────────────────────────────────────────────────────────────
 * The findings have to be real findings. A mock returning `{findings: []}` would make both
 * implementations trivially agree — `persist_tajweed_findings` returns early on an empty array — and
 * this test would pass against a service that stores nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  queryJson,
  request,
  reservePort,
  startApi,
  startShell,
  uniqueSuffix,
} from "./lib/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ML_ENTRY = join(root, "services/ml-inference/server.mjs");
const ML_KEY = "tajweed-effects-ml-key";

/** Everything this test needs the shell to answer itself. Anything absent here is proxied to Rust. */
const PORTED = [
  "POST /v1/ml/tajweed-findings:predict",
  "POST /v1/recitation-sessions",
  "POST /v1/recitation-sessions/{id}/alignments",
].join(",");

let ml;
let mlStderr = "";
let storageDir;
let api;
let shell;
let rustUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "tajweed-effects-"));
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
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${mlUrl}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`ml-inference never came up\n${mlStderr}`);
    await sleep(50);
  }

  api = await startApi({ env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({
    upstream: rustUrl,
    env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY, NODE_API_PORTED: PORTED },
  });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
  if (ml && ml.exitCode === null) {
    ml.kill("SIGTERM");
    const hard = Date.now() + 5_000;
    while (ml.exitCode === null && Date.now() < hard) await sleep(25);
    if (ml.exitCode === null) ml.kill("SIGKILL");
  }
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

/**
 * A session with real word alignments, created through `base`.
 *
 * Each implementation gets its OWN session: `persist_tajweed_findings` short-circuits on a session
 * that has already been analysed, so a shared one would let the second implementation pass by
 * inheriting the first one's rows.
 */
async function seededSession(base) {
  const learner = "learner-1";
  const created = await request(base, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      learnerId: learner,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
      sourceChecksum: "fnv1a32:effects",
      modelVersion: "model-v0.3",
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
  assert.equal(created.status, 200, `session create failed: ${created.text}`);
  const sessionId = created.body.id ?? created.body.sessionId;

  const words = await queryJson(
    "SELECT id FROM canonical_words WHERE ayah_id = '1:1' ORDER BY word_index LIMIT 2",
  );
  assert.equal(words.length, 2, `need 2 canonical words from 1:1, got ${words.length}`);
  const aligned = await request(base, `/v1/recitation-sessions/${sessionId}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      alignments: [
        {
          wordId: words[0].id,
          heardText: "x",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          status: "matched",
        },
        {
          wordId: words[1].id,
          heardText: "y",
          startMs: 100,
          endMs: 200,
          confidence: 0.5,
          status: "misread",
        },
      ],
    },
  });
  assert.equal(aligned.status, 200, `alignment persist failed: ${aligned.text}`);
  assert.equal(aligned.body.persisted, 2, `alignments not persisted: ${aligned.text}`);
  return { learner, sessionId };
}

const implementations = () => [
  ["shell", shell.baseUrl],
  ["rust", rustUrl],
];

test("a prediction stores findings a teacher can review, in both implementations", async () => {
  for (const [impl, base] of implementations()) {
    const { learner, sessionId } = await seededSession(base);
    const trace = `effects-${uniqueSuffix()}`;

    const predicted = await request(base, "/v1/ml/tajweed-findings:predict", {
      method: "POST",
      role: "learner",
      userId: learner,
      headers: { "x-trace-id": trace },
      body: { sessionId, quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" } },
    });
    assert.equal(predicted.status, 200, `${impl}: predict failed: ${predicted.text}`);
    assert.ok(
      Array.isArray(predicted.body?.findings) && predicted.body.findings.length > 0,
      `${impl}: the ML service returned no findings, so this test would pass vacuously`,
    );

    const stored = await queryJson(
      `SELECT tf.id, tf.review_status, tf.analysis_basis, tf.model_version_id, tf.audit_event_id
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
        WHERE wa.session_id = $1`,
      [sessionId],
    );
    assert.ok(
      stored.length > 0,
      `${impl}: the prediction returned ${predicted.body.findings.length} findings and stored NONE. ` +
        `They existed for the length of the response — no teacher can review one, and nothing ` +
        `records that the ML call happened.`,
    );

    // Every stored finding is a MODEL's opinion about the canonical text, and must say so. A row
    // that arrives already `teacher-reviewed`, or claiming an acoustic basis, is a claim about a
    // human judgement nobody made.
    for (const row of stored) {
      assert.equal(row.review_status, "ai-suggested", `${impl}: finding ${row.id} review_status`);
      assert.equal(row.analysis_basis, "canonical-text", `${impl}: finding ${row.id} analysis_basis`);
      assert.ok(row.model_version_id, `${impl}: finding ${row.id} names no model version`);
      assert.ok(row.audit_event_id, `${impl}: finding ${row.id} is anchored to no audit event`);
    }

    const audit = await queryJson(
      `SELECT id, action, actor_id, subject_id, metadata->>'trace_id' AS trace_id
         FROM audit_events WHERE id = $1`,
      [stored[0].audit_event_id],
    );
    assert.equal(audit.length, 1, `${impl}: the finding's audit_event_id resolves to no row`);
    assert.equal(audit[0].action, "ml.tajweed.persisted", `${impl}: audit action`);
    assert.equal(audit[0].subject_id, sessionId, `${impl}: audit names a different session`);
    assert.equal(
      audit[0].trace_id,
      trace,
      `${impl}: the audit row does not carry the caller's trace, so the finding cannot be joined ` +
        `to the ML call that produced it`,
    );
    // `actor_id` REFERENCES users(id): the authenticated caller, never a synthetic service name.
    assert.equal(audit[0].actor_id, learner, `${impl}: audit actor`);
  }
});

test("a session with nothing to anchor to records no findings AND no audit claim", async () => {
  // Found by mutation: deleting the no-alignments guard left the first two tests GREEN, because both
  // seed alignments. Without the guard the finding loop stores nothing — every wordId misses the
  // empty alignment map — but the audit row is written anyway, claiming `findingCount: 5`. An audit
  // event asserting five findings were persisted when zero were is worse than no audit event: it is
  // evidence that reads as fact and is false.
  for (const [impl, base] of implementations()) {
    const learner = "learner-1";
    const created = await request(base, "/v1/recitation-sessions", {
      method: "POST",
      role: "learner",
      userId: learner,
      body: {
        learnerId: learner,
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
        sourceChecksum: "fnv1a32:noalign",
        modelVersion: "model-v0.3",
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
    assert.equal(created.status, 200, `${impl}: session create failed: ${created.text}`);
    const sessionId = created.body.id ?? created.body.sessionId;

    // Deliberately NO alignments posted.
    const predicted = await request(base, "/v1/ml/tajweed-findings:predict", {
      method: "POST",
      role: "learner",
      userId: learner,
      body: { sessionId, quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" } },
    });
    assert.equal(predicted.status, 200, `${impl}: predict failed: ${predicted.text}`);

    const audit = await queryJson(
      `SELECT id, metadata->>'findingCount' AS finding_count
         FROM audit_events
        WHERE action = 'ml.tajweed.persisted' AND subject_id = $1`,
      [sessionId],
    );
    assert.equal(
      audit.length,
      0,
      `${impl}: an audit row claims ${audit[0]?.finding_count} tajweed findings were persisted for a ` +
        `session with no alignments — nothing could have been stored, so the claim is false`,
    );
  }
});

test("re-running analysis on an already-analysed session does not duplicate findings", async () => {
  // The "already analysed" short-circuit is the first thing `persist_tajweed_findings` checks, and a
  // port that dropped it would double a teacher's review queue on every retry — including the
  // automatic ones a flaky network produces.
  for (const [impl, base] of implementations()) {
    const { learner, sessionId } = await seededSession(base);
    const body = {
      sessionId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    };
    const opts = { method: "POST", role: "learner", userId: learner, body };

    const first = await request(base, "/v1/ml/tajweed-findings:predict", opts);
    assert.equal(first.status, 200, `${impl}: first predict failed: ${first.text}`);
    const after1 = await queryJson(
      `SELECT tf.id FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1`,
      [sessionId],
    );

    const second = await request(base, "/v1/ml/tajweed-findings:predict", opts);
    assert.equal(second.status, 200, `${impl}: second predict failed: ${second.text}`);
    const after2 = await queryJson(
      `SELECT tf.id FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1`,
      [sessionId],
    );

    assert.ok(after1.length > 0, `${impl}: nothing stored on the first run`);
    assert.equal(
      after2.length,
      after1.length,
      `${impl}: re-running analysis duplicated the findings (${after1.length} -> ${after2.length})`,
    );
  }
});

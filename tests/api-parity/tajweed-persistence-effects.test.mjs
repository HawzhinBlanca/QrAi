/**
 * Deterministic Tajweed instruction must never become learner-performance state.
 *
 *   node --test tests/api-parity/tajweed-persistence-effects.test.mjs
 *
 * ── Why this is not an `assertAB` probe ─────────────────────────────────────────────────────────
 * `assertAB` cannot see an unsafe INSERT. This suite therefore proves the database effect directly:
 * the real rule engine returns instructional `annotations`, the performance `findings` array is
 * empty, and neither runtime creates a `tajweed_findings` row or a false persistence audit.
 *
 * ── Why the real ml-inference ───────────────────────────────────────────────────────────────────
 * A mock returning empty arrays would prove nothing. The real service must return at least one
 * deterministic annotation for Al-Fatihah 1:1, while still returning zero acoustic findings.
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

test("real text rules remain instructional and create no performance rows, in both implementations", async () => {
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
    assert.ok(Array.isArray(predicted.body?.annotations), `${impl}: annotations is not an array`);
    assert.ok(predicted.body.annotations.length > 0, `${impl}: real rule engine returned no instruction`);
    assert.deepEqual(predicted.body.findings, [], `${impl}: text rules leaked into performance findings`);
    for (const annotation of predicted.body.annotations) {
      assert.equal(annotation.analysisBasis, "text-rule", `${impl}: annotation basis`);
      assert.equal(annotation.instructional, true, `${impl}: annotation is not explicitly instructional`);
      for (const forbidden of ["confidence", "severity", "reviewStatus"]) {
        assert.equal(
          Object.hasOwn(annotation, forbidden),
          false,
          `${impl}: instructional annotation invented performance field ${forbidden}`,
        );
      }
    }

    const stored = await queryJson(
      `SELECT tf.id, tf.review_status, tf.analysis_basis, tf.model_version_id, tf.audit_event_id
         FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
        WHERE wa.session_id = $1`,
      [sessionId],
    );
    assert.deepEqual(stored, [], `${impl}: instructional text rules were persisted as performance`);

    const audit = await queryJson(
      `SELECT id FROM audit_events
        WHERE action = 'ml.tajweed.persisted' AND subject_id = $1`,
      [sessionId],
    );
    assert.deepEqual(audit, [], `${impl}: audit falsely claims performance findings were persisted`);
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

test("re-running deterministic analysis is stable and never creates performance rows", async () => {
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

    assert.ok(first.body.annotations.length > 0, `${impl}: first run returned no instruction`);
    const semantics = (response) =>
      response.body.annotations.map(({ wordId, rule, explanation, sources, sourceChecksum }) => ({
        wordId,
        rule,
        explanation,
        sources,
        sourceChecksum,
      }));
    assert.deepEqual(semantics(second), semantics(first), `${impl}: deterministic instruction drifted`);
    assert.deepEqual(after1, [], `${impl}: first run persisted instruction as performance`);
    assert.deepEqual(after2, [], `${impl}: retry persisted instruction as performance`);
  }
});

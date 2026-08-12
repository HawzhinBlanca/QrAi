import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

/**
 * @journey: mobile-finalize
 *
 * A learner recites on the phone, and a teacher can see it afterwards.
 *
 * ── Why this exists, and why nothing caught the defect it now guards ────────────────────────────
 * `learner-practice-journey.test.mjs` covers what happens to an analysis AFTER a session has
 * alignments — and it SEEDS those alignments, deliberately, "rather than produced by `/finalize`,
 * which would pull the ASR service into this journey". That is a reasonable boundary for that
 * journey and it left the other side unowned: nothing ran stream → finalize → analyse in one pass.
 *
 * Both halves were individually correct. The join was not, and it was the whole mobile product:
 *
 *     finalize -> 200 {"finalized": true, "persisted": 0}
 *     word_alignments: 0
 *     analyse  -> 200, 38 findings returned
 *     tajweed_findings stored: 0
 *
 * Every session recorded on a phone was dropped before it reached a teacher, while the client was
 * told it had been finalised. `practice_screen.dart` calls `finalizeSession` FIRST precisely to
 * create the alignments a finding anchors to, so the ordering was right and the result was empty.
 *
 * The cause was one hop: `recognizedWordsFrom` reduced the ASR's timed segments to bare strings, so
 * the aligner had nothing to place a word in time with, emitted alignments with no span, and
 * `usable_span` refused every one of them.
 *
 * ── Why a STUB ASR and not the real one ─────────────────────────────────────────────────────────
 * The real ASR is a Whisper service this repository does not run in CI, and the point here is not
 * whether Whisper hears Arabic correctly — it is whether a transcript that HAS timings still has
 * them by the time an alignment is written. The stub returns the canonical words of Al-Fatihah 1:1
 * with per-word timings, which is exactly the input the real service produces and the narrowest
 * thing that can prove the hop.
 *
 * Requires a live Postgres. Creates its own learner and session.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ML_ENTRY = join(root, "services/ml-inference/server.mjs");
const ML_KEY = "mobile-finalize-ml-key";

/** Al-Fatihah 1:1, the words `canonical_words` holds for ayah 1:1. */
const RECITED = ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَٰنِ", "ٱلرَّحِيمِ"];

let ml;
let mlUrl;
let mlStderr = "";
let asr;
let storageDir;
let api;
let rustUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // A stub ASR: ml-inference POSTs ASR_SERVICE_URL/v1/transcribe and reads `words[].word`.
  // The timings are the entire subject of this journey, so they are reported per word.
  const asrPort = await reservePort();
  asr = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text: RECITED.join(" "),
          words: RECITED.map((word, i) => ({
            word,
            startMs: i * 500,
            endMs: (i + 1) * 500,
            confidence: 0.92,
          })),
        }),
      );
    });
  });
  await new Promise((resolve) => asr.listen(asrPort, "127.0.0.1", resolve));

  storageDir = mkdtempSync(join(tmpdir(), "mobile-finalize-"));
  const mlPort = await reservePort();
  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ASR_SERVICE_URL: `http://127.0.0.1:${asrPort}`,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (d) => {
    mlStderr += `[ml] ${d}`;
  });

  mlUrl = `http://127.0.0.1:${mlPort}`;
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
});

after(async () => {
  await api?.stop();
  if (ml && ml.exitCode === null) {
    ml.kill("SIGTERM");
    const hard = Date.now() + 5_000;
    while (ml.exitCode === null && Date.now() < hard) await sleep(25);
    if (ml.exitCode === null) ml.kill("SIGKILL");
  }
  await new Promise((resolve) => (asr ? asr.close(resolve) : resolve()));
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

/** Its own learner: this journey writes alignments and findings against whoever it names. */
async function createLearner(label) {
  const res = await request(rustUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: TENANT,
      displayName: `mobile finalize ${label}`,
      role: "learner",
      language: "ckb",
      email: `mobile-finalize-${label}-${uniqueSuffix()}@example.test`,
      password: "MobileFinalize1234",
    },
  });
  assert.equal(res.status, 200, `creating a learner failed: ${res.text}`);
  const id = res.body.id ?? res.body.userId;
  assert.ok(id, `no user id in ${res.text}`);
  return id;
}

async function createSessionFor(learnerId) {
  const res = await request(rustUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      learnerId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: "fnv1a32:mobilefinalize",
      modelVersion: "model-v0.3",
      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "teacher-review",
        // Both true, or session-transcript refuses before the ASR is ever called and this journey
        // would measure the consent gate instead of the hop it exists for.
        externalAsrProcessing: true,
        guardianApproved: true,
        anonymizedLearning: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(res.status, 200, `session create failed: ${res.text}`);
  return res.body.id ?? res.body.sessionId;
}

/** Store a chunk the way the realtime gateway forwards one — straight into ml-inference. */
async function streamChunk(learnerId, sessionId, index) {
  const res = await fetch(`${mlUrl}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": ML_KEY },
    body: JSON.stringify({
      tenantId: TENANT,
      learnerId,
      sessionId,
      chunkId: `${sessionId}-ws-${String(index).padStart(4, "0")}`,
      startMs: index * 500,
      endMs: (index + 1) * 500,
      sampleRate: 16000,
      audioRetention: "teacher-review",
      audioBase64: Buffer.from(new Array(64).fill(index + 1)).toString("base64"),
    }),
  });
  assert.equal(res.status, 200, `storing chunk ${index} failed: ${await res.text()}`);
}

test("a session recited on the phone reaches a teacher's queue", async () => {
  const learner = await createLearner("happy");
  const session = await createSessionFor(learner);
  for (let i = 0; i < 3; i++) await streamChunk(learner, session, i);

  // The order practice_screen.dart documents: finalise FIRST, because a finding anchors to an
  // alignment and analysing before this would leave every finding unanchored.
  const finalized = await request(rustUrl, `/v1/recitation-sessions/${session}/finalize`, {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {},
  });
  assert.equal(finalized.status, 200, `finalize failed: ${finalized.text}`);
  assert.equal(
    finalized.body.finalized,
    true,
    `finalize did not finalize: ${finalized.text}. If the reason is "alignments-unusable" the ` +
      `aligner produced rows with no usable span and every one was refused — the mobile defect.`,
  );

  // The assertion that would have failed before the fix, and the reason this journey exists.
  const persisted = Number(finalized.body.persisted ?? 0);
  assert.ok(
    persisted > 0,
    `finalize stored ${persisted} alignments out of ${finalized.body.alignmentsOffered} offered. ` +
      `Nothing anchors a tajweed finding, so this session can never reach a teacher.`,
  );

  const alignments = await queryJson(
    "SELECT count(*)::int AS n FROM word_alignments WHERE session_id = $1",
    [session],
  );
  assert.ok(alignments[0].n > 0, "finalize reported alignments and the table has none");

  // And the half that makes it a product: an analysis that a teacher can actually review.
  const analysed = await request(rustUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      sessionId: session,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      words: [],
    },
  });
  assert.equal(analysed.status, 200, `analyse failed: ${analysed.text}`);

  const stored = await queryJson(
    `SELECT count(*)::int AS n FROM tajweed_findings f
       JOIN word_alignments w ON w.id = f.alignment_id
      WHERE w.session_id = $1`,
    [session],
  );
  assert.ok(
    stored[0].n > 0,
    `the analysis returned findings and stored ${stored[0].n}. A learner recited, the model had ` +
      `something to say, and no teacher will ever see it.`,
  );
});

test("a word that was never heard gets no span, and is not stored as one that was", async () => {
  // The other direction, and the one a naive fix breaks. Only 4 of Al-Fatihah's words are recited
  // by the stub; the rest are `missed`. A missed word must NOT acquire a span — a finding anchors
  // to the alignment, so a fabricated span points it at audio the learner never recited there.
  // `usable_span` refusing those is correct behaviour, not the defect.
  const learner = await createLearner("missed");
  const session = await createSessionFor(learner);
  for (let i = 0; i < 3; i++) await streamChunk(learner, session, i);

  const finalized = await request(rustUrl, `/v1/recitation-sessions/${session}/finalize`, {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {},
  });
  assert.equal(finalized.status, 200, `finalize failed: ${finalized.text}`);

  const offered = Number(finalized.body.alignmentsOffered ?? 0);
  const persisted = Number(finalized.body.persisted ?? 0);
  assert.ok(
    offered > persisted,
    `the aligner offered ${offered} and ${persisted} were stored. The stub recites ` +
      `${RECITED.length} of the passage's words, so the unrecited ones must be offered and ` +
      `refused — if every offered alignment persists, missed words are being given a span.`,
  );

  // Every stored row identifies real audio. This is the property `usable_span` exists for, asserted
  // against what actually landed rather than against the rule.
  const bad = await queryJson(
    `SELECT count(*)::int AS n FROM word_alignments
      WHERE session_id = $1 AND NOT (start_ms >= 0 AND end_ms > start_ms)`,
    [session],
  );
  assert.equal(bad[0].n, 0, "a stored alignment does not identify any audio");
});

// The one claim `server.test.mjs` could not make: that a session's audio chunks are assembled in
// the order they were SPOKEN. Needs an ASR endpoint to receive the assembled audio, so it spins a
// loopback mock rather than reaching the real service — no torch, no model download, no network
// beyond 127.0.0.1.
//
// Why it matters: chunk ids are UUIDs. Ordering by filename is arbitrary, and arbitrary order does
// not fail — it produces a fluent transcript of a recitation in the wrong sequence, which the
// aligner then scores against the canonical text as if the learner had recited it that way.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every worker request, so tests can inspect bounded-window composition without logging audio. */
let received = null;
let receivedRequests = [];

/**
 * What the mock ASR replies with. Mutable because the two shapes are BOTH real.
 *
 * The default below is the openai-whisper path: word segments AND text. The Quran-fine-tuned HF
 * checkpoint that `ASR_MODEL` defaults to in production returns `words: []` and puts the whole
 * recitation in `text` (asr-inference/server.py: "this 2022 fine-tune lacks timestamp config").
 * A mock that only ever spoke the first dialect is why nothing here noticed the second.
 */
const asrResponse = (body) => ({
  ...body,
  modelVersion: "declared-asr-fixture",
  modelAttribution: {
    schemaVersion: 1,
    primaryComponent: "asr",
    components: [
      {
        component: "asr",
        status: "active",
        implementationId: "declared-asr-fixture",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        datasetVersion: "declared-fixture",
        analysisBasis: "acoustic",
        calibratorId: null,
      },
    ],
  },
});

const forceAlignResponse = (body) => ({
  ...body,
  modelVersion: "declared-forced-aligner-fixture",
  modelAttribution: {
    schemaVersion: 1,
    primaryComponent: "forced-aligner",
    components: [
      {
        component: "forced-aligner",
        status: "active",
        implementationId: "declared-forced-aligner-fixture",
        artifactDigest: `sha256:${"b".repeat(64)}`,
        datasetVersion: "declared-fixture",
        analysisBasis: "acoustic",
        calibratorId: null,
      },
    ],
  },
});

let asrReply = asrResponse({
  words: [
    { word: "بسم", start: 0.01, end: 0.04, probability: 0.91 },
    { word: "الله", start: 0.05, end: 0.09, probability: 0.92 },
  ],
  text: "بسم الله",
});
let asrResponder = () => asrReply;
let forceAlignReply = forceAlignResponse({ words: [], duration: 0.1, latencyMs: 1 });
let forceAlignStatus = 200;
let acousticStatus = 200;
let acousticReply = {
  status: "observed",
  refusalReason: null,
  candidateId: "muaalem-v3.2-shadow",
  qpsProfileId: "hafs-murattal-madd-4-4-4-4-candidate-v1",
  qpsProfileChecksum: "sha256:304a8e010b0f8b1037be1c1eb3b1c4cd6228e4a4195d0eedd28f3848c4c0b5c8",
  observations: [
    {
      analysisBasis: "acoustic",
      calibrationStatus: "uncalibrated",
      coreWordIds: ["1:1:1"],
      referenceDigest: `sha256:${"d".repeat(64)}`,
      predictedPhonemes: "declared-fixture-output",
      phonemeRawProbabilities: [0.7],
      sifat: [],
    },
  ],
  modelVersion: "quran-muaalem:obadx/muaalem-model-v3_2@01a1ef9fbe40d144ef845101e89ff924aed3fef5",
  modelAttribution: {
    schemaVersion: 1,
    primaryComponent: "acoustic-scorer",
    components: [
      {
        component: "acoustic-scorer",
        status: "active",
        implementationId: "quran-muaalem:obadx/muaalem-model-v3_2@01a1ef9fbe40d144ef845101e89ff924aed3fef5",
        artifactDigest: "sha256:6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41",
        datasetVersion: "upstream-training-data-undisclosed",
        analysisBasis: "acoustic",
        calibratorId: null,
      },
      {
        component: "calibrator",
        status: "unavailable",
        reason: "no held-out calibration artifact has been approved",
      },
    ],
  },
};

const asr = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received = JSON.parse(body);
    receivedRequests.push({ path: req.url, body: received });
    if (req.url === "/v1/acoustic-tajweed:observe") {
      res.writeHead(acousticStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(acousticReply));
      return;
    }
    if (req.url === "/v1/force-align") {
      res.writeHead(forceAlignStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(forceAlignReply));
      return;
    }
    const transcriptionCalls = receivedRequests.filter((r) => r.path === "/v1/transcribe").length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(asrResponder(received, transcriptionCalls - 1)));
  });
});

const storage = mkdtempSync(join(tmpdir(), "ml-transcript-test-"));
process.env.AUDIO_STORAGE_DIR = storage;

let transcribeSession;
let predictAlignment;
let predictTajweed;
let getAuditEvents;

before(async () => {
  await new Promise((resolve) => asr.listen(0, "127.0.0.1", resolve));
  // Both are read at module load, so they must be set before the import.
  process.env.ASR_SERVICE_URL = `http://127.0.0.1:${asr.address().port}`;
  ({ transcribeSession, predictAlignment, predictTajweed, getAuditEvents } = await import("../../server/src/inference/runtime.mjs"));
});

after(() => asr.close());

/** A stored chunk, exactly as `storeAudioChunk` lays one down. */
function writeChunk(
  tenantId,
  learnerId,
  sessionId,
  chunkId,
  startMs,
  byte,
  { durationMs = 100, sampleRate = 16000, byteLength = null } = {},
) {
  const dir = join(storage, tenantId, learnerId);
  mkdirSync(dir, { recursive: true });
  const storedByteLength = byteLength ?? Math.round((sampleRate * 2 * durationMs) / 1000);
  writeFileSync(join(dir, `${chunkId}.bin`), Buffer.alloc(storedByteLength, byte));
  writeFileSync(
    join(dir, `${chunkId}.meta.json`),
    JSON.stringify({
      tenantId,
      learnerId,
      sessionId,
      chunkId,
      startMs,
      endMs: startMs + durationMs,
      sampleRate,
    }),
  );
}

test("sub-millisecond PCM duration rounds to integer metadata without becoming malformed", async () => {
  const t = "t-submillisecond-rounding";
  // 1,610 frames at 16 kHz are 100.625 ms. The storage contract carries integer milliseconds, so
  // the honest end is 101 ms; the 0.375 ms difference must not erase an otherwise complete chunk.
  writeChunk(t, "learner-1", "s1", "rounded", 0, 0x31, {
    durationMs: 101,
    byteLength: 1_610 * 2,
  });

  received = null;
  const out = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { guardianApproved: true, externalAsrProcessing: true },
  });

  assert.equal(out.transcribed, true);
  assert.equal(out.chunkCount, 1);
  assert.ok(received, "the rounded but complete PCM chunk never reached ASR");
});

test("chunks are assembled in spoken order, not filename order", async () => {
  const t = "t-order";
  // Filenames sort a < b < c; the audio was spoken c, b, a. Ordering by name would splice the
  // recitation backwards and the ASR would faithfully transcribe a different one.
  writeChunk(t, "learner-1", "s1", "aaa", 200, 0xaa);
  writeChunk(t, "learner-1", "s1", "bbb", 100, 0xbb);
  writeChunk(t, "learner-1", "s1", "ccc", 0, 0xcc);

  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.equal(res.transcribed, true);
  assert.equal(res.chunkCount, 3);
  assert.deepEqual(res.recognizedText, ["بسم", "الله"]);
  assert.deepEqual(res.recognizedTokens, [
    { text: "بسم", startMs: 10, endMs: 40, confidence: 0.91 },
    { text: "الله", startMs: 50, endMs: 90, confidence: 0.92 },
  ]);
  assert.equal(res.transcriptSource, "server-derived");
  assert.equal(res.modelVersion, "declared-asr-fixture");
  assert.equal(res.modelAttribution.primaryComponent, "asr");
  assert.deepEqual(
    res.modelAttribution.components.map((component) => component.component),
    ["asr"],
  );

  assert.ok(received, "the ASR service was never called");
  assert.equal(received.audioFormat, "wav", "raw PCM is not an accepted ASR format");
  const wav = Buffer.from(received.audioBase64, "base64");
  const chunkBytes = 3200;
  assert.ok(wav.subarray(44, 44 + chunkBytes).every((b) => b === 0xcc));
  assert.ok(wav.subarray(44 + chunkBytes, 44 + 2 * chunkBytes).every((b) => b === 0xbb));
  assert.ok(wav.subarray(44 + 2 * chunkBytes).every((b) => b === 0xaa));
  assert.equal(wav.readUInt32LE(24), 16000, "the header must carry the chunks' sample rate");
});

test("only THIS session's chunks are assembled", async () => {
  // One learner, two sessions, one directory. Mixing them would transcribe a recitation that
  // interleaves two different attempts.
  const t = "t-scope";
  writeChunk(t, "learner-1", "s-a", "one", 0, 0x11);
  writeChunk(t, "learner-1", "s-b", "two", 0, 0x22);

  received = null;
  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s-a",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.equal(res.chunkCount, 1);
  const wav = Buffer.from(received.audioBase64, "base64");
  assert.ok(wav.subarray(44).every((b) => b === 0x11), "another session's audio was spliced in");
});

test("a chunk whose bytes are gone refuses the transcript instead of scoring partial audio", async () => {
  // Metadata outlives the audio after an erasure. Padding invents silence; skipping it turns words
  // actually recited in the missing bytes into learner errors. Neither can support finalization.
  const t = "t-missing";
  const dir = join(storage, t, "learner-1");
  mkdirSync(dir, { recursive: true });
  writeChunk(t, "learner-1", "s1", "present", 0, 0x33);
  writeFileSync(
    join(dir, "erased.meta.json"),
    JSON.stringify({ tenantId: t, learnerId: "learner-1", sessionId: "s1", chunkId: "erased", startMs: 100, sampleRate: 16000 }),
  );

  received = null;
  receivedRequests = [];
  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.equal(res.transcribed, false);
  assert.equal(res.reason, "incomplete-audio");
  assert.deepEqual(res.missingAudioChunkIds, ["erased"]);
  assert.deepEqual(res.recognizedTokens, []);
  assert.equal(received, null, "partial audio was still sent to ASR");
});

test("consent is checked BEFORE any audio is read or sent", async () => {
  const t = "t-denied-with-audio";
  writeChunk(t, "learner-1", "s1", "one", 0, 0x44);

  received = null;
  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: false, guardianApproved: true },
  });

  assert.equal(res.transcribed, false);
  assert.equal(received, null, "audio was sent to ASR despite the learner declining");
});

// ── Gaps: chunks that were accepted upstream and never stored ───────────────────────────────────
//
// Skipping a missing chunk is honest about the AUDIO and dishonest about the SESSION. The transcript
// comes out short, the aligner scores it against the FULL canonical passage, and words the learner
// DID recite are recorded as words they missed — the same wrong answer the reconnect collision
// produced, arriving from an upstream outage instead of a bug.
//
// Measured in specs/dr-rehearsal/evidence/P5.4-partial-loss-recovery.log: an ML outage during a
// session leaves exactly this shape on disk.

test("a hole in the session's chunk run is refused, not scored as learner omissions", async () => {
  const t = "t-gap";
  // 0,1,2 then 6,7 — 3,4,5 were accepted upstream and never stored.
  for (const [n, ms] of [[0, 0], [1, 100], [2, 200], [6, 600], [7, 700]]) {
    writeChunk(t, "learner-1", "s1", `sess-ws-${String(n).padStart(4, "0")}`, ms, 0x40 + n);
  }

  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.equal(res.transcribed, false);
  assert.equal(res.reason, "incomplete-audio");
  assert.equal(res.chunkCount, 5);
  assert.deepEqual(
    res.missingChunkIds,
    ["sess-ws-0003", "sess-ws-0004", "sess-ws-0005"],
    "the gap between 0002 and 0006 was not reported",
  );
});

test("a complete session reports no gaps — and reports the field anyway", async () => {
  // Present-but-empty, not absent: a caller must be able to tell "no gaps" from "this build does
  // not look". An absent field would read as the former while meaning the latter.
  const t = "t-nogap";
  for (const [n, ms] of [[0, 0], [1, 100], [2, 200]]) {
    writeChunk(t, "learner-1", "s1", `full-ws-${String(n).padStart(4, "0")}`, ms, 0x50 + n);
  }

  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.deepEqual(res.missingChunkIds, []);
});

test("loss off the END of a session is NOT detectable, and the test says so", async () => {
  // The run has no declared upper bound, so a recitation truncated by an outage in its last seconds
  // looks complete. This is a real limit of deriving gaps from what is on disk, and it is pinned
  // here so nobody reads "missingChunkIds: []" as "nothing was lost".
  const t = "t-truncated";
  for (const [n, ms] of [[0, 0], [1, 100]]) {
    writeChunk(t, "learner-1", "s1", `trunc-ws-${String(n).padStart(4, "0")}`, ms, 0x60 + n);
  }

  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.deepEqual(
    res.missingChunkIds,
    [],
    "a truncated session cannot be distinguished from a short one without a declared chunk total",
  );
});

test("a transcript survives an ASR that returns text but no word segments", async () => {
  // The PRODUCTION topology. `ASR_MODEL` defaults to tarteel-ai/whisper-base-ar-quran, an HF
  // pipeline whose reply carries the recitation in `text` with `words: []` — the checkpoint has no
  // timestamp config, so word segments come from the separate /v1/force-align pass instead.
  //
  // Both readers here took `.words` and nothing else, so on the default model every server-side
  // transcription resolved to ZERO words. finalize_session then aligned an empty transcript against
  // the full passage and recorded every word the learner actually recited as `missed` — and since
  // ADR-0030 that empty result is the only kind of alignment counted as measured accuracy.
  //
  // Nothing failed. A learner who recited perfectly was recorded as having recited nothing.
  const t = "t-no-word-segments";
  writeChunk(t, "learner-1", "s-hf", "c1", 0, 0x01);

  const previous = asrReply;
  const previousForceAlign = forceAlignReply;
  asrReply = asrResponse({ words: [], text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ" });
  forceAlignReply = forceAlignResponse({
    words: [
      { word: "بِسْمِ", start: 0.005, end: 0.02, score: 0.81 },
      { word: "ٱللَّهِ", start: 0.02, end: 0.04, score: 0.82 },
      { word: "ٱلرَّحْمَٰنِ", start: 0.04, end: 0.065, score: 0.83 },
      { word: "ٱلرَّحِيمِ", start: 0.065, end: 0.095, score: 0.84 },
    ],
    duration: 0.1,
    latencyMs: 1,
  });
  try {
    receivedRequests = [];
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s-hf",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.equal(out.transcribed, true, `expected a transcript: ${JSON.stringify(out)}`);
    assert.deepEqual(
      out.recognizedText,
      ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَٰنِ", "ٱلرَّحِيمِ"],
      "the words are split on whitespace ONLY — every diacritic and every letter is passed " +
        "through untouched, because this is Quranic text and normalising it is forbidden",
    );
    assert.deepEqual(out.recognizedTokens, [
      { text: "بِسْمِ", startMs: 5, endMs: 20, confidence: 0.81 },
      { text: "ٱللَّهِ", startMs: 20, endMs: 40, confidence: 0.82 },
      { text: "ٱلرَّحْمَٰنِ", startMs: 40, endMs: 65, confidence: 0.83 },
      { text: "ٱلرَّحِيمِ", startMs: 65, endMs: 95, confidence: 0.84 },
    ]);
    assert.equal(out.transcriptSource, "server-derived");
    assert.equal(out.modelVersion, "declared-asr-fixture");
    assert.deepEqual(
      out.modelAttribution.components.map((component) => component.component),
      ["asr", "forced-aligner"],
    );
    const forced = receivedRequests.find((r) => r.path === "/v1/force-align");
    assert.equal(
      forced?.body?.transcript,
      "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
      "force alignment must receive the recognized transcript byte-for-byte, never canonical text",
    );
  } finally {
    asrReply = previous;
    forceAlignReply = previousForceAlign;
  }
});

test("word segments still win when the ASR provides them", async () => {
  // The other direction. Deriving words from `text` unconditionally would throw away the segment
  // boundaries the whisper path does produce, and with them any chance of per-word timing.
  const t = "t-word-segments-win";
  writeChunk(t, "learner-1", "s-whisper", "c1", 0, 0x01);

  const previous = asrReply;
  // `text` deliberately disagrees with `words`: if the fallback fired anyway, the assertion below
  // reads the wrong one and says so.
  asrReply = asrResponse({
    words: [
      { word: "بسم", start: 0.01, end: 0.04, probability: 0.91 },
      { word: "الله", start: 0.05, end: 0.09, probability: 0.92 },
    ],
    text: "not the words",
  });
  try {
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s-whisper",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.deepEqual(out.recognizedText, ["بسم", "الله"]);
  } finally {
    asrReply = previous;
  }
});

test("malformed ASR spans fail closed instead of falling back to invented timing", async () => {
  const t = "t-malformed-spans";
  writeChunk(t, "learner-1", "s1", "c1", 0, 0x04);
  const previous = asrReply;
  asrReply = asrResponse({
    words: [{ word: "بسم", start: 0.08, end: 0.02, probability: 0.9 }],
    text: "بسم",
  });
  try {
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s1",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.equal(out.transcribed, false);
    assert.equal(out.reason, "invalid-recognized-spans");
    assert.deepEqual(out.recognizedTokens, []);
  } finally {
    asrReply = previous;
  }
});

test("timestamp-less recognition refuses when the forced aligner is unavailable", async () => {
  const t = "t-force-align-unavailable";
  writeChunk(t, "learner-1", "s1", "c1", 0, 0x05);
  const previousAsr = asrReply;
  const previousStatus = forceAlignStatus;
  const previousReply = forceAlignReply;
  asrReply = asrResponse({ words: [], text: "بسم" });
  forceAlignStatus = 501;
  forceAlignReply = { detail: "forced alignment unavailable" };
  try {
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s1",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.equal(out.transcribed, false);
    assert.equal(out.reason, "forced-alignment-unavailable");
    assert.deepEqual(out.recognizedTokens, []);
  } finally {
    asrReply = previousAsr;
    forceAlignStatus = previousStatus;
    forceAlignReply = previousReply;
  }
});

test("mixed sample rates refuse before any ASR request", async () => {
  const t = "t-mixed-rate";
  writeChunk(t, "learner-1", "s1", "sess-ws-0000", 0, 0x06);
  writeChunk(t, "learner-1", "s1", "sess-ws-0001", 100, 0x07, { sampleRate: 48000 });
  received = null;
  receivedRequests = [];
  const out = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { guardianApproved: true, externalAsrProcessing: true },
  });
  assert.equal(out.transcribed, false);
  assert.equal(out.reason, "inconsistent-audio-format");
  assert.deepEqual(out.recognizedTokens, []);
  assert.equal(received, null);
});


test("tajweed shadow analysis consumes retained audio and server-derived spans without leaking raw output", async () => {
  const tenantId = "t-acoustic-shadow";
  const learnerId = "learner-1";
  const sessionId = "session-acoustic-shadow";
  writeChunk(tenantId, learnerId, sessionId, "shadow-ws-0000", 0, 0x11, {
    durationMs: 1200,
    sampleRate: 16000,
  });
  receivedRequests = [];

  const result = await predictTajweed({
    tenantId,
    learnerId,
    sessionId,
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    sourceChecksum: "declared-canonical-checksum",
    acousticSegments: [{ wordId: "1:1:1", startMs: 100, endMs: 600 }],
    consent: { guardianApproved: true, externalAsrProcessing: true, audioRetention: "discard" },
  });

  assert.deepEqual(result.findings, []);
  assert.equal(Object.hasOwn(result, "observations"), false);
  assert.equal(JSON.stringify(result).includes("declared-fixture-output"), false);
  const calls = receivedRequests.filter((entry) => entry.path === "/v1/acoustic-tajweed:observe");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sampleRate, 16000);
  assert.ok(typeof calls[0].body.audioBase64 === "string" && calls[0].body.audioBase64.length > 44);
  assert.deepEqual(calls[0].body.coreWordIds, ["1:1:1"]);
  assert.deepEqual(
    calls[0].body.segments.map(({ wordId, startMs, endMs }) => ({ wordId, startMs, endMs })),
    [{ wordId: "1:1:1", startMs: 100, endMs: 600 }],
  );

  const audit = getAuditEvents(tenantId).at(-1);
  assert.equal(audit.action, "ml.tajweed.predicted");
  assert.deepEqual(audit.details.acousticShadow, {
    status: "observed",
    candidateId: "muaalem-v3.2-shadow",
    qpsProfileId: "hafs-murattal-madd-4-4-4-4-candidate-v1",
    modelVersion: acousticReply.modelVersion,
    observationCount: 1,
    windowCount: 1,
    refusalReason: null,
  });
});


test("tajweed shadow refuses before reading audio when stored consent is insufficient", async () => {
  const tenantId = "t-acoustic-denied";
  writeChunk(tenantId, "learner-1", "session-acoustic-denied", "denied-ws-0000", 0, 0x22);
  receivedRequests = [];

  const result = await predictTajweed({
    tenantId,
    learnerId: "learner-1",
    sessionId: "session-acoustic-denied",
    quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
    sourceChecksum: "declared-canonical-checksum",
    acousticSegments: [{ wordId: "1:1:1", startMs: 0, endMs: 100 }],
    consent: { guardianApproved: true, externalAsrProcessing: false, audioRetention: "discard" },
  });

  assert.deepEqual(result.findings, []);
  assert.equal(receivedRequests.some((entry) => entry.path === "/v1/acoustic-tajweed:observe"), false);
  const audit = getAuditEvents(tenantId).at(-1);
  assert.equal(audit.details.acousticShadow.status, "refused");
  assert.equal(audit.details.acousticShadow.refusalReason, "consent-revoked-or-insufficient");
})

test("a metadata timeline gap with non-sequential ids is still incomplete audio", async () => {
  const t = "t-timeline-gap";
  writeChunk(t, "learner-1", "s1", "arbitrary-a", 0, 0x08);
  writeChunk(t, "learner-1", "s1", "arbitrary-b", 200, 0x09);
  received = null;
  receivedRequests = [];
  const out = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { guardianApproved: true, externalAsrProcessing: true },
  });
  assert.equal(out.transcribed, false);
  assert.equal(out.reason, "incomplete-audio");
  assert.equal(received, null);
});

test("forced spans must correspond exactly to every recognized token", async () => {
  const t = "t-force-align-mismatch";
  writeChunk(t, "learner-1", "s1", "c1", 0, 0x0a);
  const previousAsr = asrReply;
  const previousForceAlign = forceAlignReply;
  asrReply = asrResponse({ words: [], text: "بسم الله" });
  forceAlignReply = forceAlignResponse({
    words: [
      { word: "بسم", start: 0.01, end: 0.04, score: 0.8 },
      { word: "الرحمن", start: 0.05, end: 0.09, score: 0.8 },
    ],
    duration: 0.1,
    latencyMs: 1,
  });
  try {
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s1",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.equal(out.transcribed, false);
    assert.equal(out.reason, "invalid-recognized-spans");
    assert.deepEqual(out.recognizedTokens, []);
  } finally {
    asrReply = previousAsr;
    forceAlignReply = previousForceAlign;
  }
});

test("sessions over 120 seconds use bounded context windows and preserve absolute repeated tokens", async () => {
  const t = "t-bounded-windows";
  for (const [n, startMs] of [[0, 0], [1, 45000], [2, 90000]]) {
    writeChunk(
      t,
      "learner-1",
      "s1",
      `sess-ws-${String(n).padStart(4, "0")}`,
      startMs,
      0x10 + n,
      { durationMs: 45000 },
    );
  }

  const previousResponder = asrResponder;
  asrResponder = (_body, index) => index === 0
    ? asrResponse({
        words: [{ word: "كرر", start: 89.4, end: 90.4, probability: 0.9 }],
        text: "كرر",
      })
    : asrResponse({
        words: [
          // Same acoustic token in the 2s overlap: core ownership must discard this copy.
          { word: "كرر", start: 1.4, end: 2.4, probability: 0.9 },
          // A legitimate immediate repetition after the boundary must survive.
          { word: "كرر", start: 3.1, end: 3.5, probability: 0.88 },
        ],
        text: "كرر كرر",
      });
  receivedRequests = [];
  try {
    const out = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s1",
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    assert.equal(out.transcribed, true, JSON.stringify(out));
    assert.equal(out.windowCount, 2);
    assert.deepEqual(out.recognizedTokens, [
      { text: "كرر", startMs: 89400, endMs: 90400, confidence: 0.9 },
      { text: "كرر", startMs: 91100, endMs: 91500, confidence: 0.88 },
    ]);
    assert.deepEqual(out.recognizedText, ["كرر", "كرر"]);
    assert.equal(out.transcriptSource, "server-derived");
    assert.equal(out.modelVersion, "declared-asr-fixture");
    assert.deepEqual(
      out.modelAttribution.components.map((component) => component.component),
      ["asr"],
      "identical ASR attribution from two windows must be stored once",
    );
    const requests = receivedRequests.filter((r) => r.path === "/v1/transcribe");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const wav = Buffer.from(request.body.audioBase64, "base64");
      const frames = wav.readUInt32LE(40) / 2;
      const durationSeconds = frames / wav.readUInt32LE(24);
      assert.ok(durationSeconds <= 120, `worker received ${durationSeconds}s`);
    }
  } finally {
    asrResponder = previousResponder;
  }
});

test("the ALIGNMENT path also survives an ASR that returns text but no word segments", async () => {
  // `recognizedWordsFrom` has two callers and the test above only exercises one. A shared helper
  // that half the code still bypasses is the shape of the reconnect-cursor bug: the API behaved
  // perfectly while nothing called it.
  //
  // This is the web/Flutter live-analysis path rather than finalize. Same model, same empty
  // `words`, same outcome if the text is ignored — every canonical word scored as `missed`.
  const previous = asrReply;
  asrReply = asrResponse({ words: [], text: "بِسْمِ ٱللَّهِ" });
  try {
    const out = await predictAlignment({
      tenantId: "t-align-hf",
      sessionId: "s-align-hf",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
      audioBase64: Buffer.from([0x01, 0x02]).toString("base64"),
      // ALL THREE are required. `asrAllowed` is
      // `externalAsrRequested && consent.externalAsrProcessing && consent.guardianApproved`, and the
      // first version of this test omitted `externalAsrRequested`. The ASR was therefore never
      // called at all, the canonical fallback ran, and the test passed — including when the fix it
      // exists for was mutated away. A test that cannot fail is not a test.
      externalAsrRequested: true,
      consent: { guardianApproved: true, externalAsrProcessing: true },
    });
    // The mock ASR is what must have been consulted. Without this the canonical fallback would
    // satisfy the assertion below on its own, which is exactly how the first version passed.
    assert.deepEqual(
      out.externalAsr,
      { called: true, reason: "consent-granted" },
      `the ASR was not consulted, so this test proves nothing about it`,
    );
    const heard = out.alignments.filter((a) => a.status !== "missed");
    assert.ok(
      heard.length > 0,
      `every word was scored as missed, so the learner recited nothing as far as this service is ` +
        `concerned: ${JSON.stringify(out.alignments.map((a) => [a.canonicalText, a.status]))}`,
    );
  } finally {
    asrReply = previous;
  }
});

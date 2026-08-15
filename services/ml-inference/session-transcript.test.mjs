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

/** Whatever the ASR was last asked to transcribe, so the test can inspect the assembled audio. */
let received = null;

/**
 * What the mock ASR replies with. Mutable because the two shapes are BOTH real.
 *
 * The default below is the openai-whisper path: word segments AND text. The Quran-fine-tuned HF
 * checkpoint that `ASR_MODEL` defaults to in production returns `words: []` and puts the whole
 * recitation in `text` (asr-inference/server.py: "this 2022 fine-tune lacks timestamp config").
 * A mock that only ever spoke the first dialect is why nothing here noticed the second.
 */
let asrReply = { words: [{ word: "بسم" }, { word: "الله" }], text: "بسم الله" };

/**
 * When true the mock DROPS the connection instead of answering.
 *
 * `ASR_SERVICE_URL` is read once at module load, so a test cannot point the service at a dead port
 * by reassigning the env var — the module already holds the mock's address. Destroying the socket
 * makes the same thing happen at the same layer: the fetch rejects instead of returning a response.
 */
let asrDropsConnection = false;

const asr = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (asrDropsConnection) {
      req.socket.destroy();
      return;
    }
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(asrReply));
  });
});

const storage = mkdtempSync(join(tmpdir(), "ml-transcript-test-"));
process.env.AUDIO_STORAGE_DIR = storage;

let transcribeSession;
let predictAlignment;

before(async () => {
  await new Promise((resolve) => asr.listen(0, "127.0.0.1", resolve));
  // Both are read at module load, so they must be set before the import.
  process.env.ASR_SERVICE_URL = `http://127.0.0.1:${asr.address().port}`;
  ({ transcribeSession, predictAlignment } = await import("./server.mjs"));
});

after(() => asr.close());

/** A stored chunk, exactly as `storeAudioChunk` lays one down. */
function writeChunk(tenantId, learnerId, sessionId, chunkId, startMs, byte) {
  const dir = join(storage, tenantId, learnerId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chunkId}.bin`), Buffer.from([byte, byte]));
  writeFileSync(
    join(dir, `${chunkId}.meta.json`),
    JSON.stringify({ tenantId, learnerId, sessionId, chunkId, startMs, endMs: startMs + 100, sampleRate: 16000 }),
  );
}

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

  assert.ok(received, "the ASR service was never called");
  assert.equal(received.audioFormat, "wav", "raw PCM is not an accepted ASR format");
  const wav = Buffer.from(received.audioBase64, "base64");
  assert.deepEqual(
    [...wav.subarray(44)],
    [0xcc, 0xcc, 0xbb, 0xbb, 0xaa, 0xaa],
    "assembled out of spoken order — startMs 0, 100, 200",
  );
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
  assert.deepEqual([...wav.subarray(44)], [0x11, 0x11], "another session's audio was spliced in");
});

test("a chunk whose bytes are gone is skipped, not heard as silence", async () => {
  // Metadata outlives the audio after an erasure. Padding the gap would put a pause into the
  // recitation that the learner never made.
  const t = "t-missing";
  const dir = join(storage, t, "learner-1");
  mkdirSync(dir, { recursive: true });
  writeChunk(t, "learner-1", "s1", "present", 0, 0x33);
  writeFileSync(
    join(dir, "erased.meta.json"),
    JSON.stringify({ tenantId: t, learnerId: "learner-1", sessionId: "s1", chunkId: "erased", startMs: 100, sampleRate: 16000 }),
  );

  received = null;
  const res = await transcribeSession({
    tenantId: t,
    learnerId: "learner-1",
    sessionId: "s1",
    consent: { externalAsrProcessing: true, guardianApproved: true },
  });

  assert.equal(res.chunkCount, 1, "only the chunk that still has audio");
  const wav = Buffer.from(received.audioBase64, "base64");
  assert.deepEqual([...wav.subarray(44)], [0x33, 0x33]);
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

test("a hole in the session's chunk run is reported, not silently skipped", async () => {
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

  assert.equal(res.chunkCount, 5, "the five chunks that exist are still transcribed");
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
  asrReply = { words: [], text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ", modelVersion: "tarteel-ai/whisper-base-ar-quran" };
  try {
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
  } finally {
    asrReply = previous;
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
  asrReply = { words: [{ word: "بسم" }, { word: "الله" }], text: "not the words" };
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

test("the ALIGNMENT path also survives an ASR that returns text but no word segments", async () => {
  // `recognizedWordsFrom` has two callers and the test above only exercises one. A shared helper
  // that half the code still bypasses is the shape of the reconnect-cursor bug: the API behaved
  // perfectly while nothing called it.
  //
  // This is the web/Flutter live-analysis path rather than finalize. Same model, same empty
  // `words`, same outcome if the text is ignored — every canonical word scored as `missed`.
  const previous = asrReply;
  asrReply = { words: [], text: "بِسْمِ ٱللَّهِ" };
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

test("an ASR that cannot be reached is a 502 that names no internals", async () => {
  // The non-ok branch was already a clean 502. A CONNECTION failure was not handled at all, so the
  // raw fetch rejection escaped as `500 {"error":"fetch failed"}` — measured against the running
  // service with no ASR listening.
  //
  // Two separate wrongs. The STATUS said "this service is broken" when the truth was "a dependency
  // is down": platform-api's `finalize` maps any non-2xx from here to `ML service error`, so an ASR
  // outage looked identical to a defect in this service, and a caller deciding whether to retry got
  // the wrong signal. The BODY was an undifferentiated Node error string, which is not the boundary
  // the non-ok branch beside it already keeps.
  const t = "t-asr-down";
  writeChunk(t, "learner-1", "s-down", "one", 0, 0x31);

  asrDropsConnection = true;
  try {
    const err = await transcribeSession({
      tenantId: t,
      learnerId: "learner-1",
      sessionId: "s-down",
      consent: { externalAsrProcessing: true, guardianApproved: true },
    }).then(
      (ok) => ({ unexpected: ok }),
      (e) => e,
    );

    assert.ok(
      !err.unexpected,
      `an unreachable ASR produced a transcript: ${JSON.stringify(err.unexpected)}`,
    );
    assert.equal(
      err.status,
      502,
      `an unreachable dependency must not be reported as this service failing (got ${err.status})`,
    );
    // The caller's side of the boundary. The address and the driver's wording belong in the log,
    // which is where the fix puts them.
    assert.doesNotMatch(
      err.message,
      /127\.0\.0\.1|fetch failed/,
      `the error names internals: ${err.message}`,
    );
  } finally {
    asrDropsConnection = false;
  }
});

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

const asr = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ words: [{ word: "بسم" }, { word: "الله" }], text: "بسم الله" }));
  });
});

const storage = mkdtempSync(join(tmpdir(), "ml-transcript-test-"));
process.env.AUDIO_STORAGE_DIR = storage;

let transcribeSession;

before(async () => {
  await new Promise((resolve) => asr.listen(0, "127.0.0.1", resolve));
  // Both are read at module load, so they must be set before the import.
  process.env.ASR_SERVICE_URL = `http://127.0.0.1:${asr.address().port}`;
  ({ transcribeSession } = await import("./server.mjs"));
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

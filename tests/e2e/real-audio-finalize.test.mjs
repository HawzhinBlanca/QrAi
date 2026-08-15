import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { queryJson, request } from "../api-parity/lib/harness.mjs";
import {
  realAudioCapture as capture,
  startRealAudioFinalizeHarness,
} from "./lib/real-audio-finalize-harness.mjs";

let harness;

before(async () => {
  harness = await startRealAudioFinalizeHarness("w17-real-audio-finalize");
});

after(async () => {
  await harness?.stop();
});

test("real recitation spans map to canonical words and only evidence-backed rows persist", async () => {
  const finalized = await request(
    harness.api.baseUrl,
    `/v1/recitation-sessions/${harness.sessionId}/finalize`,
    { method: "POST", role: "learner", body: {} },
  );
  assert.equal(finalized.status, 200, finalized.text);
  assert.equal(finalized.body.finalized, true);
  assert.equal(finalized.body.persisted, 15);
  assert.equal(harness.getAsrRequests(), 2, "92.71 seconds must use two bounded ASR windows");

  const rows = await queryJson(
    `SELECT word_id, heard_text, start_ms, end_ms, confidence::float8, status, transcript_source
     FROM word_alignments WHERE session_id = $1 ORDER BY start_ms`,
    [harness.sessionId],
  );
  assert.equal(rows.length, 15);
  assert.deepEqual(
    Object.fromEntries(
      ["matched", "misread"].map((status) => [
        status,
        rows.filter((row) => row.status === status).length,
      ]),
    ),
    { matched: 11, misread: 4 },
  );
  assert.ok(rows.every((row) => row.transcript_source === "server-derived"));
  assert.ok(rows.every((row) => !row.word_id.startsWith("extra-")));

  let previousStart = -1;
  let previousEnd = -1;
  for (const row of rows) {
    const startMs = Number(row.start_ms);
    const endMs = Number(row.end_ms);
    assert.ok(startMs >= 0 && endMs > startMs, JSON.stringify(row));
    assert.ok(startMs >= previousStart && endMs >= previousEnd, JSON.stringify(row));
    assert.ok(
      capture.words.some(
        (word) =>
          word.word === row.heard_text &&
          Math.round(word.start * 1000) === startMs &&
          Math.round(word.end * 1000) === endMs,
      ),
      `persisted span was not present in the captured real ASR response: ${JSON.stringify(row)}`,
    );
    previousStart = startMs;
    previousEnd = endMs;
  }

  assert.equal(rows[0].word_id, "1:1:1");
  assert.equal(rows[0].heard_text, "بسم");
  assert.equal(Number(rows[0].start_ms), 9000);
  assert.equal(Number(rows[0].end_ms), 9740);
  assert.ok(
    !rows.some((row) => row.word_id === "1:1:3"),
    "an omitted canonical word received a fabricated row/span",
  );
  assert.ok(
    !rows.some((row) => row.heard_text === "قوض"),
    "an extra ASR token was persisted as a canonical recitation fact",
  );
});

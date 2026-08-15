import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planAcousticWindows } from "../../server/src/inference/runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));


test("acoustic windows are bounded, reference-aware, and assign every core word exactly once", () => {
  const sampleRate = 16_000;
  const pcm = Buffer.alloc(sampleRate * 2 * 32);
  const canonicalWords = Array.from({ length: 16 }, (_, index) => ({
    id: `1:1:${index + 1}`,
    text: `word-${index + 1}`,
  }));
  const segments = canonicalWords.map((word, index) => ({
    wordId: word.id,
    startMs: index * 2_000 + 100,
    endMs: index * 2_000 + 1_100,
  }));

  const windows = planAcousticWindows(pcm, sampleRate, segments, canonicalWords);

  assert.ok(windows.length > 1);
  assert.ok(windows.every((window) => window.durationMs <= 15_000));
  assert.ok(windows.every((window) => window.sampleRate === 16_000));
  assert.ok(windows.every((window) => window.referenceText.length > 0));
  assert.ok(windows.every((window) => Buffer.isBuffer(window.pcm) && window.pcm.length > 0));
  assert.deepEqual(
    windows.flatMap((window) => window.coreWordIds),
    canonicalWords.map((word) => word.id),
  );
});


test("acoustic windows reject unsupported rates, unknown words, and spanless evidence", () => {
  const pcm = Buffer.alloc(16_000 * 2);
  const canonicalWords = [{ id: "1:1:1", text: "word-1" }];

  assert.throws(
    () => planAcousticWindows(pcm, 48_000, [{ wordId: "1:1:1", startMs: 0, endMs: 500 }], canonicalWords),
    (error) => error?.reason === "unsupported-sample-rate",
  );
  assert.throws(
    () => planAcousticWindows(pcm, 16_000, [{ wordId: "1:1:2", startMs: 0, endMs: 500 }], canonicalWords),
    (error) => error?.reason === "invalid-server-derived-spans",
  );
  assert.throws(
    () => planAcousticWindows(pcm, 16_000, [{ wordId: "1:1:1", startMs: 0, endMs: 0 }], canonicalWords),
    (error) => error?.reason === "invalid-server-derived-spans",
  );
});


test("acoustic context never includes a word cut by the window boundary", () => {
  const sampleRate = 16_000;
  const pcm = Buffer.alloc(sampleRate * 2 * 14);
  const canonicalWords = [
    { id: "1:1:1", text: "word-1" },
    { id: "1:1:2", text: "word-2" },
  ];
  const windows = planAcousticWindows(
    pcm,
    sampleRate,
    [
      { wordId: "1:1:1", startMs: 0, endMs: 12_000 },
      { wordId: "1:1:2", startMs: 12_000, endMs: 14_000 },
    ],
    canonicalWords,
  );

  assert.equal(windows.length, 2);
  for (const window of windows) {
    assert.ok(window.segments.every(({ startMs, endMs }) => (
      startMs >= 0 && endMs > startMs && endMs <= window.durationMs
    )));
  }
  assert.deepEqual(windows.map(({ referenceText }) => referenceText), ["word-1", "word-2"]);
});


test("production has no approved calibrator and the acoustic path remains public-output empty", () => {
  const registry = JSON.parse(readFileSync(
    join(here, "..", "..", "services", "asr-inference", "calibrator-registry.json"),
    "utf8",
  ));
  const serverSource = readFileSync(join(here, "..", "..", "server", "src", "inference", "runtime.mjs"), "utf8");

  assert.deepEqual(registry, {
    schemaVersion: 1,
    activeCalibratorId: null,
    calibrators: [],
  });
  assert.match(serverSource, /const acousticShadow = await runAcousticShadow/);
  assert.match(serverSource, /findings:\s*\[\]/);
  assert.match(serverSource, /observation\.calibrationStatus !== "uncalibrated"/);
  assert.doesNotMatch(serverSource, /observation\.calibrationStatus === "calibrated"/);
});

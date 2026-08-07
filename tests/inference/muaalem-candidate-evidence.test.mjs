import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const VECTOR_PATH = path.join(ROOT, "tests/fixtures/audio/muaalem-shadow-vectors.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    result.error?.code === "ENOENT"
      ? "ffmpeg is required to reproduce the acoustic shadow vectors"
      : result.stderr,
  );
}

test("Muaalem structural evidence is immutable, candidate-bound, and benchmark-ineligible", () => {
  const vectors = loadJson(VECTOR_PATH);
  const candidates = loadJson(
    path.join(ROOT, "services/asr-inference/acoustic-candidates.json"),
  );
  const candidate = candidates.candidates.find(
    (item) => item.id === candidates.activeCandidateId,
  );
  const quran = loadJson(
    path.join(ROOT, vectors.reference.canonicalBundle),
  );
  const ayah = quran.ayahs.find(
    (item) => item.ayahNumber === vectors.reference.ayah,
  );
  const referenceBytes = Buffer.from(ayah.words.join(" "), "utf8");

  assert.equal(vectors.schemaVersion, 1);
  assert.equal(vectors.evidenceEligibility, "integration-fixture-only-not-model-evaluation");
  assert.equal(vectors.releaseEligible, false);
  assert.equal(vectors.claim, "structural-shadow-difference-only-no-accuracy-claim");
  assert.equal(vectors.candidate.id, candidate.id);
  assert.equal(vectors.candidate.artifactSha256, candidate.model.artifactSha256);
  assert.equal(vectors.reference.surah, quran.surahNumber);
  assert.deepEqual(
    vectors.reference.wordIds,
    ayah.words.map((_, index) => `1:1:${index + 1}`),
  );
  assert.equal(`sha256:${sha256(referenceBytes)}`, vectors.reference.textSha256);
  assert.match(vectors.exactImageProof.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(vectors.exactImageProof.observations.length, 2);
  assert.ok(vectors.exactImageProof.observations.every((item) => item.status === "observed"));
  assert.ok(
    vectors.exactImageProof.observations.every((item) => item.containsLearnerFinding === false),
  );
  assert.ok(
    vectors.exactImageProof.observations.every((item) => item.containsConfidence === false),
  );
  assert.ok(
    vectors.exactImageProof.observations.every((item) => item.allSifatScoresWithheld === true),
  );
  assert.notEqual(
    vectors.exactImageProof.observations[0].predictedPhonemesSha256,
    vectors.exactImageProof.observations[1].predictedPhonemesSha256,
  );

  const performance = vectors.exactImageProof.performanceObservation;
  assert.equal(performance.claim, "single-host-engineering-observation-only-not-release-benchmark");
  assert.equal(performance.benchmarkEligible, false);
  assert.equal(performance.releaseCriteriaSatisfied, false);
  assert.equal(performance.imageDigest, vectors.exactImageProof.imageDigest);
  assert.equal(performance.inputSha256, vectors.correct.sha256);
  assert.ok(Number.isInteger(performance.cold.serverLatencyMs));
  assert.ok(performance.cold.serverLatencyMs > 0);
  assert.ok(performance.cold.wallLatencyMs >= performance.cold.serverLatencyMs);
  assert.ok(Number.isInteger(performance.warm.serverLatencyMs));
  assert.ok(performance.warm.serverLatencyMs > 0);
  assert.ok(performance.warm.wallLatencyMs >= performance.warm.serverLatencyMs);
  assert.ok(performance.memory.sampleCount >= 2);
  assert.ok(performance.memory.peakContainerMemoryMiB >= performance.memory.finalContainerMemoryMiB);
  assert.ok(performance.memory.finalContainerMemoryMiB > 0);
  assert.equal(candidate.requiredReleaseGates.latencyAndMemory, false);
});

test("declared correct and muted vectors reproduce byte-for-byte", () => {
  const vectors = loadJson(VECTOR_PATH);
  const source = path.join(ROOT, vectors.source.file);
  assert.equal(sha256(readFileSync(source)), vectors.source.sha256);

  const temporary = mkdtempSync(path.join(os.tmpdir(), "qrai-muaalem-vectors-"));
  const correct = path.join(temporary, "correct.wav");
  const altered = path.join(temporary, "altered.wav");
  try {
    runFfmpeg([
      "-ss",
      String(vectors.correct.clipStartSeconds),
      "-i",
      source,
      "-t",
      String(vectors.correct.durationSeconds),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      correct,
    ]);
    assert.equal(sha256(readFileSync(correct)), vectors.correct.sha256);

    runFfmpeg([
      "-i",
      correct,
      "-af",
      `volume=enable='between(t,${vectors.altered.muteStartSeconds},${vectors.altered.muteEndSeconds})':volume=0`,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      altered,
    ]);
    assert.equal(sha256(readFileSync(altered)), vectors.altered.sha256);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

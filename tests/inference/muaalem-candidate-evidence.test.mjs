import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

function wavFromPcm16(pcm, sampleRate, channels) {
  const frameBytes = channels * 2;
  assert.ok(Number.isSafeInteger(sampleRate) && sampleRate > 0);
  assert.ok(Number.isSafeInteger(channels) && channels > 0);
  assert.equal(pcm.length % frameBytes, 0, "PCM must contain complete sample frames");

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * frameBytes;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function slicePcmFrames(pcm, startSample, sampleCount, channels) {
  assert.ok(Number.isSafeInteger(startSample) && startSample >= 0);
  assert.ok(Number.isSafeInteger(sampleCount) && sampleCount > 0);
  const frameBytes = channels * 2;
  const start = startSample * frameBytes;
  const end = (startSample + sampleCount) * frameBytes;
  assert.ok(end <= pcm.length, "declared PCM clip must fit the manifest-bound source");
  return Buffer.from(pcm.subarray(start, end));
}

function mutePcmFrames(pcm, startSample, endSampleExclusive, channels) {
  assert.ok(Number.isSafeInteger(startSample) && startSample >= 0);
  assert.ok(Number.isSafeInteger(endSampleExclusive) && endSampleExclusive > startSample);
  const frameBytes = channels * 2;
  const end = endSampleExclusive * frameBytes;
  assert.ok(end <= pcm.length, "declared mute must fit the derived clip");
  const muted = Buffer.from(pcm);
  muted.fill(0, startSample * frameBytes, end);
  return muted;
}

test("Muaalem vector derivation is manifest-bound and sample-exact", () => {
  const vectors = loadJson(VECTOR_PATH);
  const manifestPath = path.join(ROOT, vectors.source.manifest);
  const manifest = loadJson(manifestPath);

  assert.equal(vectors.schemaVersion, 2);
  assert.equal(vectors.id, "muaalem-v3.2-shadow-structural-v2");
  assert.equal(vectors.correct.derivation, "manifest-pcm-sample-slice-canonical-wav-v1");
  assert.equal(
    vectors.correct.startSample,
    vectors.correct.clipStartSeconds * vectors.correct.sampleRate,
  );
  assert.equal(
    vectors.correct.sampleCount,
    vectors.correct.durationSeconds * vectors.correct.sampleRate,
  );
  assert.equal(
    vectors.altered.muteStartSample,
    vectors.altered.muteStartSeconds * vectors.correct.sampleRate,
  );
  assert.equal(
    vectors.altered.muteEndSampleExclusive,
    vectors.altered.muteEndSeconds * vectors.correct.sampleRate,
  );
  assert.equal(manifest.derivedPcm.sampleRate, vectors.correct.sampleRate);
  assert.equal(manifest.derivedPcm.channels, vectors.correct.channels);
  assert.equal(manifest.derivedPcm.bitsPerSample, 16);
  assert.equal(manifest.derivedPcm.byteLength, vectors.source.pcmByteLength);
  assert.equal(manifest.derivedPcm.sha256, vectors.source.pcmSha256);
  assert.equal(
    path.join(path.dirname(manifestPath), manifest.derivedPcm.file),
    path.join(ROOT, vectors.source.pcmFile),
  );
});

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

  assert.equal(vectors.schemaVersion, 2);
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
  const pcmSource = readFileSync(path.join(ROOT, vectors.source.pcmFile));
  assert.equal(pcmSource.length, vectors.source.pcmByteLength);
  assert.equal(sha256(pcmSource), vectors.source.pcmSha256);

  const correctPcm = slicePcmFrames(
    pcmSource,
    vectors.correct.startSample,
    vectors.correct.sampleCount,
    vectors.correct.channels,
  );
  assert.equal(sha256(correctPcm), vectors.correct.pcmSha256);
  const correctWav = wavFromPcm16(
    correctPcm,
    vectors.correct.sampleRate,
    vectors.correct.channels,
  );
  assert.equal(correctWav.length, 44 + correctPcm.length);
  assert.equal(sha256(correctWav), vectors.correct.sha256);

  const alteredPcm = mutePcmFrames(
    correctPcm,
    vectors.altered.muteStartSample,
    vectors.altered.muteEndSampleExclusive,
    vectors.correct.channels,
  );
  assert.equal(sha256(alteredPcm), vectors.altered.pcmSha256);
  const alteredWav = wavFromPcm16(
    alteredPcm,
    vectors.correct.sampleRate,
    vectors.correct.channels,
  );
  assert.equal(sha256(alteredWav), vectors.altered.sha256);
});

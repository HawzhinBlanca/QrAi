import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "audio");
const manifestPath = join(fixtureDir, "AlFatihatulKitab.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const audio = readFileSync(join(fixtureDir, manifest.file));
const pcm = readFileSync(join(fixtureDir, manifest.derivedPcm.file));
const captureBytes = readFileSync(join(fixtureDir, manifest.capture.file));
const capture = JSON.parse(captureBytes);

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

function assertMeasuredResponse(response) {
  assert.equal(typeof response.text, "string");
  assert.ok(response.text.length > 0, "real recitation produced no transcript");
  assert.ok(Array.isArray(response.words) && response.words.length > 0, "no measured words");
  assert.equal(response.modelAttribution?.primaryComponent, "asr");
  assert.equal(
    response.modelAttribution.components[0].artifactDigest,
    manifest.capture.artifactDigest,
  );

  let previousStart = -1;
  let previousEnd = -1;
  for (const word of response.words) {
    assert.equal(typeof word.word, "string");
    assert.ok(word.word.length > 0);
    assert.ok(Number.isFinite(word.start) && Number.isFinite(word.end));
    assert.ok(word.start >= 0 && word.end > word.start, JSON.stringify(word));
    assert.ok(word.start >= previousStart && word.end >= previousEnd, JSON.stringify(word));
    assert.ok(word.end <= manifest.durationSeconds + 1, JSON.stringify(word));
    assert.ok(Number.isFinite(word.probability));
    assert.ok(word.probability >= 0 && word.probability <= 1);
    previousStart = word.start;
    previousEnd = word.end;
  }
}

test("the declared real recitation fixture is byte-pinned and explicitly benchmark-ineligible", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.license, "CC0-1.0");
  assert.equal(manifest.evidenceEligibility, "integration-fixture-only-not-model-evaluation");
  assert.equal(audio.length, manifest.byteLength);
  assert.equal(digest("sha1", audio), manifest.sha1);
  assert.equal(digest("sha256", audio), manifest.sha256);
  assert.equal(pcm.length, manifest.derivedPcm.byteLength);
  assert.equal(digest("sha256", pcm), manifest.derivedPcm.sha256);
  assert.equal(pcm.length % 2, 0, "PCM16 must contain complete samples");
});

test("the captured pinned-baseline response contains real positive monotonic word spans", () => {
  assert.equal(digest("sha256", captureBytes), manifest.capture.responseSha256);
  assert.equal(manifest.capture.candidateId, "openai-whisper-base");
  assertMeasuredResponse(capture);
});

test(
  "the configured live ASR returns measured spans for the exact declared audio",
  { skip: !process.env.ASR_REAL_AUDIO_URL },
  async () => {
    const response = await fetch(`${process.env.ASR_REAL_AUDIO_URL}/v1/transcribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asr-api-key": process.env.ASR_API_KEY ?? "smoke-asr-api-key",
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        audioFormat: "ogg",
        language: "ar",
        wordTimestamps: true,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assertMeasuredResponse(JSON.parse(body));
  },
);

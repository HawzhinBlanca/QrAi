import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";


const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("services/asr-inference/acoustic-candidates.json"));


test("the shadow candidate binds an immutable model, implementation, QPS revision, and profile", () => {
  const candidate = manifest.candidates.find(({ id }) => id === manifest.activeCandidateId);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(candidate.status, "shadow-only");
  assert.equal(candidate.releaseEligible, false);
  assert.match(candidate.model.revision, /^[a-f0-9]{40}$/);
  assert.match(candidate.model.artifactSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    candidate.model.files.map(({ path }) => path).sort(),
    [
      "added_tokens.json",
      "config.json",
      "model.safetensors",
      "preprocessor_config.json",
      "special_tokens_map.json",
      "tokenizer_config.json",
      "vocab.json",
    ],
  );
  for (const file of candidate.model.files) {
    assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0);
  }
  const artifact = candidate.model.files.find(({ path }) => path === candidate.model.artifact);
  assert.equal(artifact.sha256, candidate.model.artifactSha256);
  assert.equal(artifact.sizeBytes, candidate.model.artifactSizeBytes);
  assert.match(candidate.implementation.commit, /^[a-f0-9]{40}$/);
  assert.match(candidate.qps.commit, /^[a-f0-9]{40}$/);
  const stableProfile = JSON.stringify(
    Object.fromEntries(Object.entries(candidate.qps.profile).sort(([left], [right]) => left.localeCompare(right))),
  );
  assert.equal(
    candidate.qps.profileChecksum,
    `sha256:${createHash("sha256").update(stableProfile).digest("hex")}`,
  );
  assert.equal(candidate.qps.profileStatus, "pending-scholar-approval");
  assert.ok(Object.values(candidate.requiredReleaseGates).every((value) => value === false));
});


test("the unsafe heuristic is retired and the replacement is private shadow observation only", () => {
  const server = read("services/asr-inference/server.py");
  assert.doesNotMatch(server, /\/v1\/analyze-tajweed/);
  assert.doesNotMatch(server, /_analyze_tajweed_words_sync|detect_pitch_frequency|spectral centroid/);
  assert.match(server, /\/v1\/acoustic-tajweed:observe/);
  assert.match(server, /class AcousticObservationResponse/);
  const response = server.match(/class AcousticObservationResponse[\s\S]*?\n\n\ndef /)?.[0] ?? "";
  assert.doesNotMatch(response, /findings|confidence/);
});


test("public proxies reject forged acoustic identity and inject only stored measured context", () => {
  for (const path of [
    "server/src/routes/ml-proxy.mjs",
    "services/platform-api/src/handlers/ml_proxy.rs",
  ]) {
    const source = read(path);
    assert.match(source, /learnerId is server-derived and must not be supplied/);
    assert.match(source, /acousticSegments are server-derived and must not be supplied/);
    assert.match(source, /transcript_source = 'server-derived'/);
    assert.match(source, /status IN \('matched', 'misread'\)/);
    assert.match(source, /sourceChecksum/);
  }
});


test("the learner response retains zero uncalibrated findings and never returns raw observations", () => {
  const source = read("server/src/inference/runtime.mjs");
  const predict = source.match(
    /async function predictTajweed\([\s\S]*?^\}/m,
  )?.[0] ?? "";
  assert.match(predict, /store = defaultAudioObjectStore\(\)/);
  assert.match(predict, /runAcousticShadow\(requestBody, canonicalWords, deadline, store\)/);
  assert.match(predict, /findings: \[\]/);
  assert.doesNotMatch(predict, /return \{[\s\S]*?observations/);
  assert.match(predict, /acousticShadow/);
  assert.match(source, /calibrationStatus !== "uncalibrated"/);
});


test("the ASR and single Node backend images consume the checked-in candidate manifest", () => {
  const asrDockerfile = read("services/asr-inference/Dockerfile");
  assert.match(
    asrDockerfile,
    /acoustic_tajweed\.py[\s\S]*acoustic-candidates\.json/,
  );
  assert.match(
    asrDockerfile,
    /calibration_registry\.py[\s\S]*calibrator-registry\.json/,
  );
  assert.match(asrDockerfile, /FROM runtime-base AS acoustic-candidate/);
  assert.match(asrDockerfile, /requirements\.acoustic\.lock\.txt/);
  assert.match(asrDockerfile, /ACOUSTIC_THIRD_PARTY_NOTICES\.txt/);
  assert.match(asrDockerfile, /ADD --chown=appuser:appuser --checksum=sha256:6b6a2e/);
  assert.match(asrDockerfile, /HF_HUB_OFFLINE=1/);
  assert.match(asrDockerfile, /FROM runtime AS default/);
  const acousticLock = read("services/asr-inference/requirements.acoustic.lock.txt");
  assert.match(acousticLock, /quran-muaalem @ https:\/\/codeload\.github\.com\/obadx\/quran-muaalem\/tar\.gz\/2e444e/);
  assert.match(acousticLock, /quran-transcript @ https:\/\/codeload\.github\.com\/obadx\/quran-transcript\/tar\.gz\/fb64a1/);
  assert.match(
    read("server/Dockerfile"),
    /services\/asr-inference\/acoustic-candidates\.json/,
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = (relativePath) => readFileSync(join(repo, relativePath), "utf8");

const privacySource = source("server/src/routes/privacy.mjs");
const reviewSource = source("server/src/routes/review.mjs");
const mainSource = source("server/src/main.mjs");
const workerSource = source("server/src/worker.mjs");
const realtimeSource = source("server/src/realtime/main.mjs");
const ingressSource = source("server/src/inference/compatibility-ingress.mjs");
const gatewayRetentionSource = source("tests/gateway/audio-retention-e2e.test.mjs");
const gatewayIndexFailureSource = source("tests/gateway/index-failure-e2e.test.mjs");

test("privacy inventory and erasure use the injected store or fail closed", () => {
  assert.match(privacySource, /if \(!ctx\.audioObjectStore\)/);
  assert.match(privacySource, /ctx\.audioObjectStore\.listLearner/);
  assert.match(privacySource, /ctx\.audioObjectStore\.deleteLearner/);
  assert.doesNotMatch(privacySource, /fetchWithDeadline|ctx\.mlInferenceUrl/);
});

test("teacher playback has no transitional inference HTTP fallback", () => {
  assert.match(reviewSource, /if \(!ctx\.audioObjectStore\)/);
  assert.match(reviewSource, /ctx\.audioObjectStore\.get/);
  assert.doesNotMatch(reviewSource, /fetchWithDeadline|ctx\.mlInferenceUrl|audio-objects:read/);
});

test("all three Node process roles construct and inject the same storage boundary", () => {
  for (const [name, processSource] of [
    ["node-api", mainSource],
    ["job-worker", workerSource],
    ["node-realtime", realtimeSource],
  ]) {
    assert.match(processSource, /createAudioObjectStoreFromEnv\(/, `${name} does not construct storage`);
    assert.match(processSource, /audioObjectStore,/, `${name} does not inject storage`);
  }
  assert.match(workerSource, /createInferenceRuntime\(\{\s*audioObjectStore,?\s*\}\)/);
});

test("the worker compatibility listener exposes only the measured Rust migration surface", () => {
  for (const path of [
    "/v1/alignments:predict",
    "/v1/audio-chunks",
    "/v1/audio-objects:read",
    "/v1/privacy/delete",
    "/v1/session-transcript",
    "/v1/tajweed-findings:predict",
  ]) assert.ok(ingressSource.includes(path), `missing compatibility path ${path}`);
  assert.match(ingressSource, /request\.headers\["x-ml-api-key"\] === mlApiKey/);
  assert.match(ingressSource, /knownPaths\.has\(url\.pathname\)/);
});

test("real Rust gateway proofs target the worker ingress instead of the retired ML process", () => {
  for (const gatewayProof of [gatewayRetentionSource, gatewayIndexFailureSource]) {
    assert.match(gatewayProof, /startWorkerCompatibilityIngress/);
    assert.doesNotMatch(gatewayProof, /services\/ml-inference|ML_ENTRY/);
  }
});

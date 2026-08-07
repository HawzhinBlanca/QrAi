import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEPLOYABLE_IMAGES, DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";
import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
  createReleaseDeploymentSelection,
  verifyRunningReleaseApplicationImages,
  verifyRunningReleaseImages,
} from "../../scripts/lib/release-deployment.mjs";

const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const namespace = "ExampleOwner";
const deploymentScript = fileURLToPath(new URL("../../scripts/release-deployment.mjs", import.meta.url));

function imageDigests(seed) {
  return Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [key, `sha256:${String(seed + index).repeat(64)}`]),
  );
}

function selection() {
  return createReleaseDeploymentSelection({
    candidateSha,
    candidateImageDigests: imageDigests(1),
    previousSha,
    previousImageDigests: imageDigests(2),
    namespace,
    createdAt: "2026-08-07T20:00:00.000Z",
  });
}

test("one deployment selection preserves distinct candidate and previous immutable manifests", () => {
  const value = selection();
  assert.equal(value.schemaVersion, "qrai-release-deployment/v1");
  assert.equal(value.registryNamespace, "exampleowner");
  assert.equal(value.candidate.sourceSha, candidateSha);
  assert.deepEqual(value.candidate.imageDigests, imageDigests(1));
  assert.equal(value.previous.sourceSha, previousSha);
  assert.deepEqual(value.previous.imageDigests, imageDigests(2));
  assert.deepEqual(assertReleaseDeploymentSelection(JSON.parse(JSON.stringify(value))), value);

  assert.throws(
    () => createReleaseDeploymentSelection({
      candidateSha,
      candidateImageDigests: imageDigests(1),
      previousSha: candidateSha,
      previousImageDigests: imageDigests(1),
      namespace,
      createdAt: "2026-08-07T20:00:00.000Z",
    }),
    /candidate and previous source SHAs must differ/,
  );
});

test("candidate and rollback environments resolve every Compose role to exact registry digests", () => {
  const value = selection();
  const candidate = composeImageEnvironment(value, "candidate");
  const previous = composeImageEnvironment(value, "previous");

  assert.deepEqual(Object.keys(candidate).sort(), [
    "ASR_INFERENCE_IMAGE",
    "MIGRATION_RUNNER_IMAGE",
    "NODE_BACKEND_IMAGE",
    "PLATFORM_API_IMAGE",
    "REALTIME_GATEWAY_IMAGE",
    "WEB_IMAGE",
  ]);
  assert.match(candidate.NODE_BACKEND_IMAGE, new RegExp(`^ghcr\\.io/exampleowner/qrai-node-backend@${imageDigests(1)["node-backend"]}$`));
  assert.match(previous.NODE_BACKEND_IMAGE, new RegExp(`@${imageDigests(2)["node-backend"]}$`));
  assert.notDeepEqual(candidate, previous);
});

test("running-image proof fails closed on missing, stopped, substituted, or content-mismatched containers", () => {
  const value = selection();
  const environment = composeImageEnvironment(value, "candidate");
  const expectedByService = Object.fromEntries(
    DEPLOYABLE_IMAGES.flatMap(({ key, composeServices }) =>
      composeServices.map((service) => [service, environment[`${key.toUpperCase().replaceAll("-", "_")}_IMAGE`]]),
    ),
  );
  const imageId = `sha256:${"f".repeat(64)}`;
  const observations = Object.fromEntries(
    Object.entries(expectedByService).map(([service, reference]) => [service, {
      containerId: `${service}-container`,
      configuredImage: reference,
      imageId,
      localImageId: imageId,
      repoDigests: [reference],
      running: true,
    }]),
  );

  const evidence = verifyRunningReleaseImages({ selection: value, slot: "candidate", observations });
  assert.equal(evidence.length, 7);
  assert.equal(evidence.filter(({ reference }) => reference === environment.NODE_BACKEND_IMAGE).length, 2);

  for (const [mutation, pattern] of [
    [(copy) => { delete copy.web; }, /missing running image observation.*web/],
    [(copy) => { copy["node-api"].running = false; }, /node-api is not running/],
    [(copy) => { copy["job-worker"].configuredImage = "ghcr.io/example/wrong@sha256:" + "a".repeat(64); }, /job-worker configured image/],
    [(copy) => { copy["platform-api"].localImageId = `sha256:${"e".repeat(64)}`; }, /platform-api image content/],
  ]) {
    const copy = structuredClone(observations);
    mutation(copy);
    assert.throws(() => verifyRunningReleaseImages({ selection: value, slot: "candidate", observations: copy }), pattern);
  }
});

test("application rollback proof verifies six services and deliberately excludes the migration runner", () => {
  const value = selection();
  const environment = composeImageEnvironment(value, "previous");
  const references = {
    "platform-api": environment.PLATFORM_API_IMAGE,
    "node-api": environment.NODE_BACKEND_IMAGE,
    "job-worker": environment.NODE_BACKEND_IMAGE,
    "realtime-gateway": environment.REALTIME_GATEWAY_IMAGE,
    "asr-inference": environment.ASR_INFERENCE_IMAGE,
    web: environment.WEB_IMAGE,
  };
  const imageId = `sha256:${"d".repeat(64)}`;
  const observations = Object.fromEntries(
    Object.entries(references).map(([service, reference]) => [service, {
      containerId: `${service}-previous`,
      configuredImage: reference,
      imageId,
      localImageId: imageId,
      repoDigests: [reference],
      running: true,
    }]),
  );

  const evidence = verifyRunningReleaseApplicationImages({
    selection: value,
    slot: "previous",
    observations,
  });
  assert.equal(evidence.length, 6);
  assert.ok(evidence.every(({ service }) => service !== "migrations"));
  assert.throws(
    () => verifyRunningReleaseImages({ selection: value, slot: "previous", observations }),
    /missing running image observation for migrations/,
  );
});

test("the deployment CLI writes a preserved selection and candidate/rollback Compose environments", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qrai-release-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidateDigests = join(directory, "candidate.json");
  const previousDigests = join(directory, "previous.json");
  const selectionPath = join(directory, "selection.json");
  const candidateEnv = join(directory, "candidate.env");
  const previousEnv = join(directory, "previous.env");
  writeFileSync(candidateDigests, JSON.stringify(imageDigests(1)));
  writeFileSync(previousDigests, JSON.stringify(imageDigests(2)));

  const create = spawnSync(process.execPath, [
    deploymentScript,
    "create",
    "--candidate-sha", candidateSha,
    "--candidate-digests", candidateDigests,
    "--previous-sha", previousSha,
    "--previous-digests", previousDigests,
    "--namespace", namespace,
    "--created-at", "2026-08-07T20:00:00.000Z",
    "--output", selectionPath,
  ], { encoding: "utf8" });
  assert.equal(create.status, 0, `${create.stdout}${create.stderr}`);

  for (const [slot, output] of [["candidate", candidateEnv], ["previous", previousEnv]]) {
    const result = spawnSync(process.execPath, [
      deploymentScript,
      "env",
      "--selection", selectionPath,
      "--slot", slot,
      "--output", output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }

  assert.deepEqual(assertReleaseDeploymentSelection(JSON.parse(readFileSync(selectionPath, "utf8"))), selection());
  assert.match(readFileSync(candidateEnv, "utf8"), new RegExp(`NODE_BACKEND_IMAGE=.*@${imageDigests(1)["node-backend"]}`));
  assert.match(readFileSync(previousEnv, "utf8"), new RegExp(`NODE_BACKEND_IMAGE=.*@${imageDigests(2)["node-backend"]}`));
});

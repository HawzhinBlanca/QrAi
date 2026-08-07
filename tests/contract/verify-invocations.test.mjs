import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const verifySource = readFileSync(join(repo, "scripts", "verify.sh"), "utf8");
const mlSmokeSource = readFileSync(join(repo, "scripts", "smoke-ml.mjs"), "utf8");
const goldenFixture = JSON.parse(
  readFileSync(join(repo, "server", "src", "inference", "fixtures", "golden-evals.json"), "utf8"),
);

const GOLDEN_REGRESSION = "tests/inference/golden-regression.test.mjs";
const INVOCATION_GUARD = "tests/contract/verify-invocations.test.mjs";
const EVAL_EVIDENCE_MIGRATION = "tests/migrations/eval-evidence-migration.test.mjs";
const JOB_OUTBOX_MIGRATION = "tests/migrations/job-outbox-migration.test.mjs";
const DEVICE_IDENTITY_MIGRATION = "tests/migrations/device-identity-migration.test.mjs";
const DEVICE_SESSIONS = "tests/node-api/device-sessions.test.mjs";
const DEVICE_ENROLLMENT = "tests/e2e/device-enrollment.test.mjs";
const DURABLE_JOBS = "tests/jobs/durable-jobs.test.mjs";
const LOCAL_INFERENCE_WORKER = "tests/jobs/local-inference-worker.test.mjs";
const COMPATIBILITY_INGRESS = "tests/inference/compatibility-ingress.test.mjs";
const AUDIO_RETENTION_WORKER = "tests/inference/audio-retention-worker.test.mjs";
const INFERENCE_COMPATIBILITY_SURFACE = "tests/contract/inference-compatibility-surface.test.mjs";
const API_JOB_WAIT = "tests/jobs/api-job-wait.test.mjs";
const INFERENCE_CANCELLATION = "tests/jobs/inference-cancellation.test.mjs";
const DURABLE_WORKFLOWS = "tests/e2e/durable-workflows.test.mjs";
const WORKER_LIFECYCLE = "tests/node-api/worker-lifecycle.test.mjs";
const JOB_BOUNDARY = "tests/security/job-boundary.test.mjs";
const MODEL_CLAIM_AUTHORITY = "tests/release/model-claim-authority.test.mjs";
const RELEASE_ARTIFACT_CONSUMPTION = "tests/release/release-artifact-consumption.test.mjs";
const RELEASE_DEPLOYMENT_SELECTION = "tests/release/release-deployment-selection.test.mjs";
const HTTP_CANARY_TOPOLOGY = "tests/contract/http-canary-topology.test.mjs";
const HTTP_CANARY_EFFECTS = "tests/e2e/http-canary-effects.test.mjs";
const HTTP_CANARY_IMAGE = "tests/release/http-canary-image.test.mjs";
const HTTP_CANARY_LOAD = "scripts/load-test.test.mjs";
const HTTP_CANARY_MONITORING = "tests/observability/http-canary-monitoring.test.mjs";
const HTTP_CANARY_CONTROLLER = "tests/release/http-canary-controller.test.mjs";
const HTTP_CANARY_ROLLBACK_EVIDENCE = "tests/release/canary-rollback-evidence.test.mjs";

function activeNodeTestLines(source) {
  return source
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));
}

test("canonical verification runs the deterministic golden regression exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const goldenInvocations = invocations.filter((line) => line.includes(GOLDEN_REGRESSION));

  assert.equal(
    goldenInvocations.length,
    1,
    `${GOLDEN_REGRESSION} must appear in exactly one active node --test invocation`,
  );
  assert.ok(
    invocations.some((line) => line.includes(INVOCATION_GUARD)),
    `${INVOCATION_GUARD} must protect its own canonical invocation`,
  );
});

test("golden regression fixture is mechanically ineligible for authoritative claims", () => {
  assert.deepEqual(
    {
      evidenceKind: goldenFixture.evidenceKind,
      evidenceEligibility: goldenFixture.evidenceEligibility,
      modelEvaluationEligible: goldenFixture.modelEvaluationEligible,
      calibrationEligible: goldenFixture.calibrationEligible,
      releaseEligible: goldenFixture.releaseEligible,
    },
    {
      evidenceKind: "deterministic-regression-fixture",
      evidenceEligibility: "fixture-only-not-model-evaluation-or-calibration",
      modelEvaluationEligible: false,
      calibrationEligible: false,
      releaseEligible: false,
    },
  );
});

test("canonical verification runs the row-authoritative offline evaluator suite exactly once", () => {
  const command = "python3 test_eval_pipeline.py";
  const activeInvocations = verifySource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(command));
  assert.equal(activeInvocations.length, 1, `${command} must run exactly once in canonical verification`);
});

test("canonical verification runs the evaluation-evidence migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(EVAL_EVIDENCE_MIGRATION)).length,
    1,
    `${EVAL_EVIDENCE_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job-outbox migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(JOB_OUTBOX_MIGRATION)).length,
    1,
    `${JOB_OUTBOX_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-identity migration suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_IDENTITY_MIGRATION)).length,
    1,
    `${DEVICE_IDENTITY_MIGRATION} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-session runtime suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_SESSIONS)).length,
    1,
    `${DEVICE_SESSIONS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the device-enrollment route suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DEVICE_ENROLLMENT)).length,
    1,
    `${DEVICE_ENROLLMENT} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job store/runtime suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DURABLE_JOBS)).length,
    1,
    `${DURABLE_JOBS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the local inference boundary suites exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    LOCAL_INFERENCE_WORKER,
    API_JOB_WAIT,
    INFERENCE_CANCELLATION,
    COMPATIBILITY_INGRESS,
    AUDIO_RETENTION_WORKER,
    INFERENCE_COMPATIBILITY_SURFACE,
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs the durable domain workflow suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(DURABLE_WORKFLOWS)).length,
    1,
    `${DURABLE_WORKFLOWS} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable worker lifecycle suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(WORKER_LIFECYCLE)).length,
    1,
    `${WORKER_LIFECYCLE} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable job security boundary exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(JOB_BOUNDARY)).length,
    1,
    `${JOB_BOUNDARY} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the expanded learner-feedback gate exactly once", () => {
  const target = "tests/contract/learner-feedback-gate.test.mjs";
  const count = activeNodeTestLines(verifySource).filter((line) => line.includes(target)).length;
  assert.equal(count, 1, `${target} must appear exactly once in the active canonical Node test command`);
});

test("canonical verification runs learner-owned delayed-review history exactly once", () => {
  const target = "tests/e2e/learner-history.test.mjs";
  const count = activeNodeTestLines(verifySource).filter((line) => line.includes(target)).length;
  assert.equal(count, 1, `${target} must appear exactly once in canonical verification`);
});

test("canonical verification runs both ordered Node boundary gates exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    "tests/node-api/middleware-order.test.mjs",
    "tests/security/node-boundary.test.mjs",
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must appear exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs all database boundary gates exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    "tests/node-api/db-architecture.test.mjs",
    "tests/node-api/db-role-guard.test.mjs",
    "tests/node-api/db-tenant.test.mjs",
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must appear exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs the shared dependency-timeout fault suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/faults/dependency-timeouts.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("canonical verification runs the bounded graceful-shutdown proof exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/node-api/graceful-shutdown.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("canonical verification runs the private audio lifecycle proof exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  const target = "tests/e2e/audio-lifecycle.test.mjs";
  assert.equal(
    invocations.filter((line) => line.includes(target)).length,
    1,
    `${target} must appear exactly once in canonical verification`,
  );
});

test("ML smoke uses the offline evaluator and signature verifier, never an online eval POST", () => {
  assert.match(mlSmokeSource, /services\/asr-inference\/evaluate_candidate\.py/);
  assert.match(mlSmokeSource, /verifyModelEvidenceBundle/);
  assert.doesNotMatch(mlSmokeSource, /postJson\(["']\/v1\/eval-runs["']/);
  assert.match(mlSmokeSource, /eligibility:\s*["']fixture-regression["']/);
  assert.match(mlSmokeSource, /releaseTrusted\s*===\s*false/);
});

test("canonical verification runs the release-authority selection suite exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  assert.equal(
    invocations.filter((line) => line.includes(MODEL_CLAIM_AUTHORITY)).length,
    1,
    `${MODEL_CLAIM_AUTHORITY} must run exactly once in canonical verification`,
  );
});

test("canonical verification runs the durable release-artifact contracts exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [RELEASE_ARTIFACT_CONSUMPTION, RELEASE_DEPLOYMENT_SELECTION]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

test("canonical verification runs every HTTP canary topology, proof, load, monitoring, and rollback contract exactly once", () => {
  const invocations = activeNodeTestLines(verifySource);
  for (const target of [
    HTTP_CANARY_TOPOLOGY,
    HTTP_CANARY_EFFECTS,
    HTTP_CANARY_IMAGE,
    HTTP_CANARY_LOAD,
    HTTP_CANARY_MONITORING,
    HTTP_CANARY_CONTROLLER,
    HTTP_CANARY_ROLLBACK_EVIDENCE,
  ]) {
    assert.equal(
      invocations.filter((line) => line.includes(target)).length,
      1,
      `${target} must run exactly once in canonical verification`,
    );
  }
});

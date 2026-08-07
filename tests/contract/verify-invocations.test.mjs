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
  readFileSync(join(repo, "services", "ml-inference", "fixtures", "golden-evals.json"), "utf8"),
);

const GOLDEN_REGRESSION = "services/ml-inference/golden-regression.test.mjs";
const INVOCATION_GUARD = "tests/contract/verify-invocations.test.mjs";
const EVAL_EVIDENCE_MIGRATION = "tests/migrations/eval-evidence-migration.test.mjs";
const MODEL_CLAIM_AUTHORITY = "tests/release/model-claim-authority.test.mjs";

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

test("canonical verification runs the expanded learner-feedback gate exactly once", () => {
  const target = "tests/contract/learner-feedback-gate.test.mjs";
  const count = activeNodeTestLines(verifySource).filter((line) => line.includes(target)).length;
  assert.equal(count, 1, `${target} must appear exactly once in the active canonical Node test command`);
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

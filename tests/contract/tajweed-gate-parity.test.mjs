import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canShowLearnerFacingAiOutput } from "../../packages/contracts/src/index.ts";
import { clearsLearnerFeedbackGate } from "../../server/src/lib/learner-feedback-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const corpus = JSON.parse(
  readFileSync(join(repo, "packages/contracts/fixtures/learner-feedback-gate.json"), "utf8"),
);

function inputFor(vector) {
  const input = structuredClone(corpus.base);
  Object.assign(input, vector.patch ?? {});
  for (const field of vector.remove ?? []) delete input[field];
  return input;
}

test("the Web contract and Node boundary agree on the shared expanded corpus", () => {
  for (const vector of corpus.cases) {
    const input = inputFor(vector);
    assert.equal(canShowLearnerFacingAiOutput(input), vector.expected, `contracts: ${vector.name}`);
    assert.equal(clearsLearnerFeedbackGate(input), vector.expected, `node: ${vector.name}`);
  }
});

test("the shared corpus exercises both answers and every authority failure class", () => {
  assert.ok(corpus.cases.some((vector) => vector.expected === true));
  assert.ok(corpus.cases.some((vector) => vector.expected === false));
  for (const failure of [
    "sources",
    "span",
    "audio",
    "model",
    "dataset",
    "calibrator",
    "evaluation",
    "fixture-bound",
    "stale",
    "audit",
  ]) {
    assert.ok(
      corpus.cases.some((vector) => vector.name.includes(failure)),
      `shared corpus does not exercise ${failure}`,
    );
  }
});

test("Rust and Flutter execute the exact same corpus rather than copied vectors", () => {
  const rust = readFileSync(join(repo, "services/platform-api/src/handlers/review.rs"), "utf8");
  const dartTest = readFileSync(join(repo, "apps/flutter/test/tajweed_gate_test.dart"), "utf8");
  assert.ok(
    rust.includes("../../../../packages/contracts/fixtures/learner-feedback-gate.json"),
    "Rust does not include the shared corpus",
  );
  assert.ok(
    dartTest.includes("../../packages/contracts/fixtures/learner-feedback-gate.json"),
    "Flutter does not load the shared corpus",
  );
});

test("every acoustic gate pins the same inclusive confidence floor", () => {
  const sources = {
    contracts: readFileSync(join(repo, "packages/contracts/src/index.ts"), "utf8"),
    node: readFileSync(join(repo, "server", "src", "lib", "learner-feedback-gate.mjs"), "utf8"),
    rust: readFileSync(join(repo, "services/platform-api/src/handlers/review.rs"), "utf8"),
    dart: readFileSync(join(repo, "apps/flutter/lib/src/api/models.dart"), "utf8"),
  };
  assert.match(sources.contracts, /record\.confidence < 0\.82/);
  assert.match(sources.node, /confidence >= 0\.82/);
  assert.match(sources.rust, /LEARNER_MIN_CONFIDENCE: f64 = 0\.82/);
  assert.match(sources.rust, /LEARNER_MIN_CONFIDENCE\.\.=1\.0/);
  assert.match(sources.dart, /learnerMinConfidence = 0\.82/);
  assert.match(sources.dart, /confidence >= learnerMinConfidence/);
});

test("every client gate consumes all complete-evidence terms", () => {
  const sources = [
    readFileSync(join(repo, "server", "src", "lib", "learner-feedback-gate.mjs"), "utf8"),
    readFileSync(join(repo, "services/platform-api/src/handlers/review.rs"), "utf8"),
    readFileSync(join(repo, "apps/flutter/lib/src/api/models.dart"), "utf8"),
  ];
  for (const term of [
    "withheld",
    "startMs",
    "endMs",
    "audioStatus",
    "evidenceId",
    "modelVersion",
    "modelArtifactSha256",
    "acousticDatasetVersion",
    "acousticDatasetManifestSha256",
    "calibratorId",
    "calibratorArtifactSha256",
    "calibrationStatus",
    "evaluationEvidenceId",
    "evaluationEvidenceSha256",
    "evaluationEvidenceStatus",
    "auditEventId",
  ]) {
    for (const source of sources) {
      assert.ok(source.includes(term), `an acoustic learner gate does not consume ${term}`);
    }
  }
});

test("the approval rule is an allowlist, not a denylist", () => {
  const invented = { ...corpus.base, reviewStatus: "definitely-fine-honest" };
  assert.equal(canShowLearnerFacingAiOutput(invented), false);
  assert.equal(clearsLearnerFeedbackGate(invented), false);
});

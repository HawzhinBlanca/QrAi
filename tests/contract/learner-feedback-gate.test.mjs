import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canShowLearnerFacingAiOutput } from "../../packages/contracts/src/index.ts";
import { clearsLearnerGate } from "../../server/src/routes/ml-proxy.mjs";

const corpus = JSON.parse(
  readFileSync(
    new URL("../../packages/contracts/fixtures/learner-feedback-gate.json", import.meta.url),
    "utf8",
  ),
);

function inputFor(vector) {
  const input = structuredClone(corpus.base);
  Object.assign(input, vector.patch ?? {});
  for (const field of vector.remove ?? []) delete input[field];
  return input;
}

test("the expanded learner-feedback corpus is non-vacuous", () => {
  assert.ok(corpus.cases.length >= 24, "the evidence mutation corpus was unexpectedly reduced");
  assert.ok(corpus.cases.some((vector) => vector.expected === true));
  assert.ok(corpus.cases.some((vector) => vector.expected === false));
  assert.ok(corpus.cases.some((vector) => vector.name.includes("fixture-bound")));
  assert.ok(corpus.cases.some((vector) => vector.name.includes("stale")));
});

test("contracts and Node apply the same complete acoustic evidence gate", () => {
  for (const vector of corpus.cases) {
    const input = inputFor(vector);
    assert.equal(canShowLearnerFacingAiOutput(input), vector.expected, `contracts: ${vector.name}`);
    assert.equal(clearsLearnerGate(input), vector.expected, `node-api: ${vector.name}`);
  }
});

test("stored finding policy keeps confidence numeric until HTTP serialization", () => {
  const source = readFileSync(new URL("../../server/src/routes/review.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function storedFindingGateInput");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "storedFindingGateInput must remain inspectable");

  const helper = source.slice(start, end);
  assert.match(helper, /confidence:\s*Number\(/, "policy input must be an ordinary number");
  assert.doesNotMatch(
    helper,
    /confidence:\s*f64\(/,
    "RustF64 is a wire wrapper and makes the shared gate's numeric type check fail closed",
  );
});

test("each production client/server names every expanded gate term", () => {
  const files = {
    rust: readFileSync(
      new URL("../../services/platform-api/src/handlers/review.rs", import.meta.url),
      "utf8",
    ),
    dart: readFileSync(new URL("../../apps/flutter/lib/src/api/models.dart", import.meta.url), "utf8"),
  };
  const requiredTerms = [
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
  ];
  for (const [runtime, source] of Object.entries(files)) {
    for (const term of requiredTerms) {
      assert.ok(source.includes(term), `${runtime} learner gate does not consume ${term}`);
    }
  }
});

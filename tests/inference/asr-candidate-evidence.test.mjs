import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const serviceDir = resolve("services/asr-inference");
const registryPath = join(serviceDir, "model-candidates.json");
const validatorPath = join(serviceDir, "candidate_evidence.py");
const sha = (character) => `sha256:${character.repeat(64)}`;

function runValidator(evidence, registry = registryPath) {
  const directory = mkdtempSync(join(tmpdir(), "qrai-asr-evidence-"));
  const evidencePath = join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return spawnSync(
    "python3",
    [validatorPath, "--registry", registry, "--evidence", evidencePath],
    { cwd: resolve("."), encoding: "utf8" },
  );
}

function declaredFixtureEvidence() {
  return {
    schemaVersion: 1,
    evidenceKind: "declared-fixture",
    candidate: {
      candidateId: "openai-whisper-base",
      runtime: "openai-whisper",
      modelId: "base",
      revision: null,
      artifactDigest: "sha256:ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
      runtimeLockDigest: sha("1"),
      imageDigest: sha("2"),
    },
    dataset: {
      version: "declared-test-fixture-v1",
      manifestDigest: sha("3"),
      split: "held-out",
      reciterDisjoint: true,
      sealed: true,
      consentStatus: "approved",
    },
    evaluator: {
      implementationDigest: sha("4"),
      sourceCommit: "5".repeat(40),
    },
    protocol: {
      version: "declared-test-protocol-v1",
      digest: sha("6"),
      approvalStatus: "approved",
      approvals: [
        { role: "product-owner", reviewerId: "fixture-owner", status: "approved" },
        { role: "quran-scholar", reviewerId: "fixture-scholar", status: "approved" },
        { role: "privacy-legal", reviewerId: "fixture-privacy", status: "approved" },
        { role: "data-steward", reviewerId: "fixture-steward", status: "approved" },
      ],
      requiredSlices: [
        {
          sliceId: "fixture-sorani-adult-ios-quiet",
          accent: "kurdish-sorani-l1",
          age: "adult",
          device: "ios-phone",
          noise: "quiet",
        },
        {
          sliceId: "fixture-badini-child-android-room",
          accent: "kurdish-badini-l1",
          age: "child",
          device: "android-phone",
          noise: "occupied-room",
        },
      ],
      thresholds: [
        { metric: "wordErrorRate", direction: "max", value: 0.3, scope: "every-slice" },
      ],
    },
    aggregateMetrics: { wordErrorRate: 0.1 },
    slices: [
      {
        sliceId: "fixture-sorani-adult-ios-quiet",
        reciterCount: 2,
        utteranceCount: 4,
        metrics: { wordErrorRate: 0.1 },
      },
      {
        sliceId: "fixture-badini-child-android-room",
        reciterCount: 2,
        utteranceCount: 4,
        metrics: { wordErrorRate: 0.2 },
      },
    ],
    resources: {
      realTimeFactorP95: 0.8,
      peakRssBytes: 100_000_000,
      imageBytes: 500_000_000,
    },
  };
}

test("candidate registry contains exact artifacts but deliberately selects no winner", () => {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.selection.status, "blocked-no-eligible-benchmark");
  assert.equal(registry.selection.selectedCandidateId, null);

  const openai = registry.candidates.find(({ id }) => id === "openai-whisper-base");
  assert.equal(openai.modelId, "base");
  assert.equal(openai.revision, null);
  assert.equal(
    openai.artifactDigest,
    "sha256:ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
  );

  const tarteel = registry.candidates.find(({ id }) => id === "tarteel-whisper-base-ar-quran");
  assert.equal(tarteel.revision, "e3f4a5f3f5336a1f0e43a2c2bdae62a680c53a8c");
  assert.equal(
    tarteel.artifactDigest,
    "sha256:ec75894993a4570a237b2b1c19fd8a448f1e8f6e083cfab699574f7be53874fa",
  );
});

test("registry validation rejects a mutable Hugging Face revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "qrai-asr-registry-"));
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.candidates.find(({ runtime }) => runtime === "huggingface-transformers").revision = "main";
  const badRegistry = join(directory, "registry.json");
  writeFileSync(badRegistry, `${JSON.stringify(registry, null, 2)}\n`);
  const result = spawnSync("python3", [validatorPath, "--registry", badRegistry], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /revision.*40-character lowercase commit/i);
});

test("registry cannot label an unlicensed or non-runnable candidate as the reviewed winner", () => {
  const directory = mkdtempSync(join(tmpdir(), "qrai-asr-winner-"));
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.selection = {
    status: "reviewed-winner",
    selectedCandidateId: "openai-whisper-base",
    evidenceDigest: sha("9"),
  };
  const badRegistry = join(directory, "registry.json");
  writeFileSync(badRegistry, `${JSON.stringify(registry, null, 2)}\n`);

  let result = spawnSync("python3", [validatorPath, "--registry", badRegistry], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /selected candidate license review must be approved/);

  const candidate = registry.candidates.find(({ id }) => id === "openai-whisper-base");
  candidate.licenseReviewStatus = "approved";
  candidate.executionStatus = "research-only";
  writeFileSync(badRegistry, `${JSON.stringify(registry, null, 2)}\n`);
  result = spawnSync("python3", [validatorPath, "--registry", badRegistry], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /selected candidate must be runnable/);
});

test("declared benchmark fixtures are valid inputs but can never become selection evidence", () => {
  const result = runValidator(declaredFixtureEvidence());
  assert.equal(result.status, 0, result.stderr);
  const assessment = JSON.parse(result.stdout);
  assert.equal(assessment.candidateBound, true);
  assert.equal(assessment.eligibleForReview, false);
  assert.ok(assessment.reasonCodes.includes("declared-fixture-ineligible"));
  assert.ok(assessment.reasonCodes.includes("candidate-license-review-pending"));
});

test("candidate mismatch and missing approved slice coverage fail closed", () => {
  const mismatched = declaredFixtureEvidence();
  mismatched.candidate.modelId = "latest";
  let result = runValidator(mismatched);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /candidate modelId does not match registry/);

  const incomplete = declaredFixtureEvidence();
  incomplete.slices.pop();
  result = runValidator(incomplete);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing required slice/);
});

test("the HF runtime passes the immutable revision into the model loader", () => {
  const server = readFileSync(join(serviceDir, "server.py"), "utf8");
  const dockerfile = readFileSync(join(serviceDir, "Dockerfile"), "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8");
  assert.match(server, /ASR_MODEL_REVISION\s*=\s*os\.environ\.get\("ASR_MODEL_REVISION"\)/);
  assert.match(server, /ASR_CANDIDATE_ID\s*=\s*os\.environ\.get\("ASR_CANDIDATE_ID"\)/);
  assert.match(server, /hf_pipeline\([\s\S]*?revision=ASR_MODEL_REVISION/);
  assert.match(server, /hf_hub_download\([\s\S]*?revision=ASR_MODEL_REVISION/);
  assert.match(server, /verify_artifact_file\([\s\S]*?candidate\["artifactDigest"\]/);
  assert.match(server, /resolve_runtime_candidate\(/);
  assert.match(dockerfile, /candidate_evidence\.py/);
  assert.match(dockerfile, /model-candidates\.json/);
  assert.match(compose, /ASR_CANDIDATE_ID:\s*"openai-whisper-base"/);
  assert.doesNotMatch(compose, /ASR_SELECTION_STATUS:/);

  const output = execFileSync(
    "python3",
    ["-c", String.raw`
from model_attribution import build_asr_attribution

revision = "c" * 40
value = build_asr_attribution(
    model_id="provider/quran-model",
    model_urls={},
    package_version="test",
    declared_digest="sha256:" + "b" * 64,
    model_revision=revision,
)
assert value["components"][0]["implementationId"].endswith("@" + revision)
`],
    { cwd: serviceDir, encoding: "utf8" },
  );
  assert.equal(output, "");
});

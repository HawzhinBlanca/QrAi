import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const manifestScript = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));
const challengeScript = fileURLToPath(new URL("./release-challenge.mjs", import.meta.url));
const requiredArtifacts = ["plan.md", "spec.md", "research.md", "impact-map.md", "tasks.md"];
const services = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function run(repo, args) {
  const result = spawnSync(process.execPath, [manifestScript, ...args], {
    cwd: repo,
    encoding: "utf8"
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function runChallenge(candidate, options = {}, extraArgs = [], environment = process.env) {
  const result = spawnSync(process.execPath, [challengeScript, ...challengeArguments(candidate, options), ...extraArgs], {
    cwd: candidate.repo,
    encoding: "utf8",
    env: environment,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.output);
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, pattern);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeEvidenceInputs({ evidenceDirectory, candidateSha, traceId, publicKeyPem, completedAt }) {
  const imageDigests = Object.fromEntries(
    services.map((service, index) => [service, `sha256:${String(index + 1).repeat(64)}`])
  );
  const buildSummaryPath = join(evidenceDirectory, "build-summary.json");
  const buildProvenancePath = join(evidenceDirectory, "build-provenance.json");
  const testSummaryPath = join(evidenceDirectory, "test-summary.json");
  const smokeSummaryPath = join(evidenceDirectory, "smoke-summary.json");
  const environmentSummaryPath = join(evidenceDirectory, "environment-summary.json");
  const sbomPath = join(evidenceDirectory, "sbom.spdx.json");
  const trustedSignersPath = join(evidenceDirectory, "trusted-signers.json");

  writeJson(buildProvenancePath, {
    schemaVersion: "qrai-build-provenance/v1",
    candidateSha,
    status: "passed",
    completedAt,
    builderId: "release-evidence-test",
    invocationId: "release-evidence-test-run",
    command: "docker buildx bake --push",
    imageDigests
  });
  writeJson(buildSummaryPath, {
    schemaVersion: "qrai-build-summary/v1",
    candidateSha,
    status: "passed",
    completedAt,
    imageDigests,
    provenance: {
      sha256: sha256(buildProvenancePath),
      builderId: "release-evidence-test",
      invocationId: "release-evidence-test-run"
    }
  });
  writeJson(testSummaryPath, {
    schemaVersion: "qrai-test-summary/v1",
    candidateSha,
    status: "passed",
    completedAt,
    command: "bash scripts/verify.sh"
  });
  writeJson(smokeSummaryPath, {
    schemaVersion: "qrai-smoke-summary/v1",
    candidateSha,
    status: "passed",
    traceId,
    completedAt,
    results: [{ step: "proof", status: "passed" }, { step: "smoke:api", status: "passed" }]
  });
  writeJson(environmentSummaryPath, {
    schemaVersion: "qrai-environment-summary/v1",
    candidateSha,
    status: "passed",
    class: "ci",
    provider: "release-evidence-test",
    completedAt
  });
  writeJson(sbomPath, {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "qrai-release-evidence-test",
    documentNamespace: `https://release-evidence.example.test/${candidateSha}`,
    creationInfo: {
      created: completedAt,
      creators: ["Tool: qrai-release-evidence-test"]
    },
    packages: []
  });
  writeJson(trustedSignersPath, {
    schemaVersion: "qrai-release-trusted-signers/v1",
    policyId: "test-release-policy",
    keys: [{ keyId: "test-release-evidence", algorithm: "ed25519", publicKey: publicKeyPem }]
  });

  return { buildSummaryPath, buildProvenancePath, testSummaryPath, smokeSummaryPath, environmentSummaryPath, sbomPath, trustedSignersPath };
}

function generateArguments(candidate, outputPath = candidate.manifestPath) {
  return [
    "--generate",
    "--output",
    outputPath,
    "--build-summary",
    candidate.buildSummaryPath,
    "--build-provenance",
    candidate.buildProvenancePath,
    "--sbom",
    candidate.sbomPath,
    "--smoke-summary",
    candidate.smokeSummaryPath,
    "--test-summary",
    candidate.testSummaryPath,
    "--environment-summary",
    candidate.environmentSummaryPath,
    "--trusted-signers",
    candidate.trustedSignersPath,
    "--signing-key",
    candidate.privateKeyPath,
    "--key-id",
    "test-release-evidence",
    "--trace-id",
    candidate.traceId,
    "--expires-at",
    candidate.expiresAt
  ];
}

function verifyArguments(candidate) {
  return [
    "--verify",
    "--manifest",
    candidate.manifestPath,
    "--build-summary",
    candidate.buildSummaryPath,
    "--build-provenance",
    candidate.buildProvenancePath,
    "--sbom",
    candidate.sbomPath,
    "--smoke-summary",
    candidate.smokeSummaryPath,
    "--test-summary",
    candidate.testSummaryPath,
    "--environment-summary",
    candidate.environmentSummaryPath,
    "--trusted-signers",
    candidate.trustedSignersPath
  ];
}

function challengeArguments(candidate, { runnerId = "independent-challenge-test", mode = "--verify-manifest-only" } = {}) {
  const argumentsList = [
    mode,
    "--candidate-dir",
    candidate.repo,
    "--manifest",
    candidate.manifestPath,
    "--build-summary",
    candidate.buildSummaryPath,
    "--build-provenance",
    candidate.buildProvenancePath,
    "--sbom",
    candidate.sbomPath,
    "--smoke-summary",
    candidate.smokeSummaryPath,
    "--test-summary",
    candidate.testSummaryPath,
    "--environment-summary",
    candidate.environmentSummaryPath,
    "--trusted-signers",
    candidate.trustedSignersPath,
    "--challenge-output",
    join(candidate.evidenceDirectory, "challenge-report.json"),
    "--runner-id",
    runnerId,
    "--runner-class",
    "independent-ci"
  ];
  if (mode === "--run-release") {
    argumentsList.push(
      "--challenge-smoke-dir",
      join(candidate.evidenceDirectory, "challenge-smoke"),
      "--challenge-test-summary",
      join(candidate.evidenceDirectory, "challenge-test-summary.json"),
      "--challenge-environment-summary",
      join(candidate.evidenceDirectory, "challenge-environment-summary.json"),
      "--challenge-trace-id",
      "release-trace-1234567890abcdef",
      "--environment-class",
      "ci",
      "--environment-provider",
      "independent-challenge-test"
    );
  }
  return argumentsList;
}

function prepareCandidate(t) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-release-manifest-repo-"));
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "qrai-release-manifest-evidence-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(evidenceDirectory, "release-private.pem");
  writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  const specDirectory = join(repo, "specs", "readiness-recovery-10-10");
  mkdirSync(specDirectory, { recursive: true });
  for (const artifact of requiredArtifacts) {
    writeFileSync(join(specDirectory, artifact), `# ${artifact}\nrelease evidence fixture\n`);
  }
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(manifestScript, join(repo, "scripts", "release-manifest.mjs"));

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Release Evidence Test"]);
  git(repo, ["config", "user.email", "release-evidence@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);

  const candidateSha = git(repo, ["rev-parse", "HEAD"]);
  const traceId = "release-trace-1234567890abcdef";
  const completedAt = new Date().toISOString();
  const evidenceInputs = writeEvidenceInputs({ evidenceDirectory, candidateSha, traceId, publicKeyPem, completedAt });
  const manifestPath = join(evidenceDirectory, "candidate-evidence.json");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const candidate = {
    repo,
    evidenceDirectory,
    manifestPath,
    privateKeyPath,
    candidateSha,
    traceId,
    expiresAt,
    ...evidenceInputs
  };
  assertSuccess(run(repo, generateArguments(candidate)));
  return candidate;
}

function updateManifest(candidate, update) {
  const manifest = readJson(candidate.manifestPath);
  update(manifest);
  writeJson(candidate.manifestPath, manifest);
}

test("verifies signed evidence for the exact clean candidate and its declared materials", (t) => {
  const candidate = prepareCandidate(t);
  assertSuccess(run(candidate.repo, verifyArguments(candidate)));
});

test("independent challenge verifies a clean candidate and labels manifest-only evidence honestly", (t) => {
  const candidate = prepareCandidate(t);
  const result = runChallenge(candidate);
  assertSuccess(result);
  const report = readJson(join(candidate.evidenceDirectory, "challenge-report.json"));
  assert.equal(report.schemaVersion, "qrai-release-challenge/v1");
  assert.equal(report.status, "manifest-verified-only");
  assert.equal(report.candidateSha, candidate.candidateSha);
  assert.equal(report.challenger.runnerId, "independent-challenge-test");
  assert.equal(report.releaseGate.status, "not-run");
});

test("independent challenge rejects a runner identity reused from build provenance", (t) => {
  const candidate = prepareCandidate(t);
  assertFailure(runChallenge(candidate, { runnerId: "release-evidence-test" }), /must differ from build provenance builderId/i);
});

test("independent challenge rejects evidence whose signed manifest was tampered", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.environment.platform = "tampered";
  });
  assertFailure(runChallenge(candidate), /signature verification failed/i);
});

test("full independent challenge refuses to run without a dedicated release database", (t) => {
  const candidate = prepareCandidate(t);
  const result = runChallenge(
    candidate,
    { mode: "--run-release" },
    [],
    { ...process.env, RELEASE_DATABASE_URL: "" },
  );
  assertFailure(result, /RELEASE_DATABASE_URL must be set/i);
  assert.equal(readJson(join(candidate.evidenceDirectory, "challenge-report.json")).status, "failed");
});

test("refuses an output path that reaches the candidate through a symlink", (t) => {
  const candidate = prepareCandidate(t);
  const candidateLink = join(candidate.evidenceDirectory, "candidate-checkout-link");
  symlinkSync(candidate.repo, candidateLink, "dir");

  assertFailure(run(candidate.repo, generateArguments(candidate, join(candidateLink, "forbidden-evidence.json"))), /must be outside the candidate checkout/i);
});

test("rejects a manifest from an earlier commit even when the tree is clean", (t) => {
  const candidate = prepareCandidate(t);
  writeFileSync(join(candidate.repo, "release-note.md"), "later commit\n");
  git(candidate.repo, ["add", "release-note.md"]);
  git(candidate.repo, ["commit", "-qm", "later evidence commit"]);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /candidate SHA does not match HEAD/i);
});

test("rejects untracked files in the candidate checkout", (t) => {
  const candidate = prepareCandidate(t);
  writeFileSync(join(candidate.repo, "untracked-release-input.txt"), "must not be ignored\n");

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /untracked or modified files/i);
});

test("rejects tracked files modified after the candidate commit", (t) => {
  const candidate = prepareCandidate(t);
  const planPath = join(candidate.repo, "specs", "readiness-recovery-10-10", "plan.md");
  writeFileSync(planPath, `${readFileSync(planPath, "utf8")}modified after evidence generation\n`);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /untracked or modified files/i);
});

test("rejects null deployable image digests", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.imageDigests.web = null;
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /non-empty sha256 digest/i);
});

test("rejects missing required artifact hashes", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    delete manifest.artifactHashes["specs/readiness-recovery-10-10/tasks.md"];
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /missing required artifact hash/i);
});

test("rejects invalid release traces", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.traceId = "not-a-release-trace";
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /traceId/i);
});

test("rejects expired release evidence", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.expiresAt = "2000-01-01T00:00:00.000Z";
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /expired/i);
});

test("rejects unsigned release evidence", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    delete manifest.signature;
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /signature/i);
});

test("rejects a signature key not authorized by the trusted signer policy", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.signature.keyId = "untrusted-release-key";
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /trusted signer policy/i);
});

test("rejects a trusted signer policy changed after evidence generation", (t) => {
  const candidate = prepareCandidate(t);
  const policy = readJson(candidate.trustedSignersPath);
  policy.policyId = "tampered-release-policy";
  writeJson(candidate.trustedSignersPath, policy);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /trusted signer policy hash/i);
});

test("rejects an SBOM changed after evidence generation", (t) => {
  const candidate = prepareCandidate(t);
  const sbom = readJson(candidate.sbomPath);
  sbom.name = "tampered-sbom";
  writeJson(candidate.sbomPath, sbom);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /SBOM hash/i);
});

test("rejects build provenance that no longer matches the declared deployable images", (t) => {
  const candidate = prepareCandidate(t);
  const provenance = readJson(candidate.buildProvenancePath);
  provenance.imageDigests.web = `sha256:${"f".repeat(64)}`;
  writeJson(candidate.buildProvenancePath, provenance);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /build provenance imageDigests/i);
});

test("rejects smoke evidence with a mismatched trace", (t) => {
  const candidate = prepareCandidate(t);
  const smoke = readJson(candidate.smokeSummaryPath);
  smoke.traceId = "release-trace-fedcba0987654321";
  writeJson(candidate.smokeSummaryPath, smoke);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /smoke summary traceId/i);
});

test("rejects a passed-looking test summary for a different candidate", (t) => {
  const candidate = prepareCandidate(t);
  const testSummary = readJson(candidate.testSummaryPath);
  testSummary.candidateSha = "0".repeat(40);
  writeJson(candidate.testSummaryPath, testSummary);

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /test summary candidateSha/i);
});

test("rejects a signed manifest whose content was changed afterwards", (t) => {
  const candidate = prepareCandidate(t);
  updateManifest(candidate, (manifest) => {
    manifest.environment.nodeVersion = "tampered";
  });

  assertFailure(run(candidate.repo, verifyArguments(candidate)), /signature verification failed/i);
});

test("retains the external evidence hashes in the signed manifest", (t) => {
  const candidate = prepareCandidate(t);
  const manifest = readJson(candidate.manifestPath);

  assert.equal(manifest.sbom.sha256, sha256(candidate.sbomPath));
  assert.equal(manifest.smoke.summarySha256, sha256(candidate.smokeSummaryPath));
  assert.equal(manifest.test.summarySha256, sha256(candidate.testSummaryPath));
  assert.equal(manifest.build.summarySha256, sha256(candidate.buildSummaryPath));
  assert.equal(manifest.build.provenanceSha256, sha256(candidate.buildProvenancePath));
  assert.equal(manifest.environment.summarySha256, sha256(candidate.environmentSummaryPath));
});

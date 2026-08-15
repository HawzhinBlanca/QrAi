import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEPLOYABLE_IMAGE_KEYS } from "./lib/deployable-images.mjs";

const manifestScript = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));
const challengeScript = fileURLToPath(new URL("./release-challenge.mjs", import.meta.url));
const deployableImagesModule = fileURLToPath(new URL("./lib/deployable-images.mjs", import.meta.url));
const requiredArtifacts = ["plan.md", "spec.md", "research.md", "impact-map.md", "tasks.md"];

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
    DEPLOYABLE_IMAGE_KEYS.map((service, index) => [service, `sha256:${String(index + 1).repeat(64)}`])
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
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  copyFileSync(deployableImagesModule, join(repo, "scripts", "lib", "deployable-images.mjs"));

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

// ── P0.7 — the independence guarantees, adversarially ────────────────────────────────────────────
//
// The five challenge tests above cover a clean run, a reused runner identity, a tampered manifest,
// the missing release database, and a symlinked OUTPUT path. What they do not cover is the property
// the whole challenge rests on: the EVIDENCE must come from outside the candidate.
//
// `release-challenge.mjs` calls `assertExternalPath` on every manifest input for exactly that
// reason. If a candidate could supply its own evidence from inside its own tree, an attacker who
// controls the checkout controls the proof, the challenge verifies a manifest the candidate wrote
// about itself, and "independently verified" means nothing. That guard had no test.
//
// P0.7's wording is "record its successful AND ADVERSARIAL FAILED runs", so each case below also
// asserts the failure REPORT — a refusal that leaves no artifact is not a recorded run.

/** The challenge report, or null when the run left none. */
function challengeReport(candidate) {
  const path = join(candidate.evidenceDirectory, "challenge-report.json");
  return existsSync(path) ? readJson(path) : null;
}

test("independent challenge refuses evidence that lives inside the candidate it is judging", (t) => {
  // The keystone. Every manifest input is probed one at a time rather than all at once, because a
  // guard that only checks the first flag would pass a test that moves all eight.
  for (const flag of [
    "--manifest",
    "--build-summary",
    "--build-provenance",
    "--sbom",
    "--smoke-summary",
    "--test-summary",
    "--environment-summary",
    "--trusted-signers",
  ]) {
    const candidate = prepareCandidate(t);
    const args = challengeArguments(candidate);
    const at = args.indexOf(flag);
    assert.notEqual(at, -1, `${flag} is no longer passed to the challenge`);

    // Same bytes, moved inside the candidate checkout AND COMMITTED. Committing matters: an
    // uncommitted copy dirties the tree, the clean-candidate guard fires first, and the test would
    // pass without ever reaching the isolation check it exists for. A real candidate carrying its
    // own evidence would carry it committed.
    const smuggled = join(candidate.repo, `smuggled-${flag.replace(/^--/, "")}.json`);
    copyFileSync(args[at + 1], smuggled);
    git(candidate.repo, ["add", "."]);
    git(candidate.repo, ["commit", "-qm", "candidate carries its own evidence"]);
    args[at + 1] = smuggled;

    const result = spawnSync(process.execPath, [challengeScript, ...args], {
      cwd: candidate.repo,
      encoding: "utf8",
      env: process.env,
    });
    assert.notEqual(result.status, 0, `${flag} was accepted from inside the candidate:\n${result.stdout}${result.stderr}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /must be outside the candidate checkout/i,
      `${flag} was refused for the wrong reason`,
    );
  }
});

test("a refused challenge still records what happened", (t) => {
  // An adversarial run that fails silently is indistinguishable from one nobody performed. The
  // no-database case above proves the report exists for ONE failure path; this proves it for a
  // failure raised much earlier, before any evidence has been read.
  const candidate = prepareCandidate(t);
  const result = runChallenge(candidate, { runnerId: "release-evidence-test" });
  assert.notEqual(result.status, 0, result.output);

  const report = challengeReport(candidate);
  assert.ok(report, "a failed challenge left no report, so the run cannot be evidence of anything");
  assert.equal(report.schemaVersion, "qrai-release-challenge/v1");
  assert.equal(report.status, "failed");
  assert.match(report.failure, /must differ from build provenance builderId/i);
  assert.equal(report.challenger.runnerId, "release-evidence-test");
});

test("independent challenge refuses a candidate directory that is not a checkout root", (t) => {
  // A subdirectory of a real repo answers `git rev-parse --show-toplevel` with the PARENT, so a
  // naive check passes while the challenge verifies a tree it has not actually pinned.
  const candidate = prepareCandidate(t);
  const inner = join(candidate.repo, "scripts");
  const args = challengeArguments(candidate);
  args[args.indexOf("--candidate-dir") + 1] = inner;

  const result = spawnSync(process.execPath, [challengeScript, ...args], {
    cwd: candidate.repo,
    encoding: "utf8",
    env: process.env,
  });
  assertFailure({ status: result.status, output: `${result.stdout}${result.stderr}` }, /must be the root of the clean candidate checkout/i);
});

test("independent challenge refuses a candidate whose tree is dirty", (t) => {
  // Distinct from the manifest's own clean-tree check: this one runs in the CHALLENGE, against the
  // candidate directory it was pointed at, which may not be the tree the manifest was made from.
  // An untracked file is the quiet case — it changes what `verify.sh --release` would execute
  // without changing any tracked content.
  const candidate = prepareCandidate(t);
  writeFileSync(join(candidate.repo, "untracked-during-challenge.txt"), "added after the commit\n");
  assertFailure(runChallenge(candidate), /untracked or modified files/i);
  assert.equal(challengeReport(candidate)?.status, "failed");
});

test("a full challenge refuses to write its two fresh summaries to one path", (t) => {
  // `--challenge-test-summary` and `--challenge-environment-summary` are separate proofs. Pointed at
  // one file, the second silently overwrites the first and the report then hashes the same bytes
  // twice under two names — two independent-looking pieces of evidence that are one.
  const candidate = prepareCandidate(t);
  const shared = join(candidate.evidenceDirectory, "one-file-for-both.json");
  const args = challengeArguments(candidate, { mode: "--run-release" });
  args[args.indexOf("--challenge-test-summary") + 1] = shared;
  args[args.indexOf("--challenge-environment-summary") + 1] = shared;

  const result = spawnSync(process.execPath, [challengeScript, ...args], {
    cwd: candidate.repo,
    encoding: "utf8",
    env: { ...process.env, RELEASE_DATABASE_URL: "postgresql://unused@127.0.0.1:1/none" },
  });
  assertFailure({ status: result.status, output: `${result.stdout}${result.stderr}` }, /must be different files/i);
});

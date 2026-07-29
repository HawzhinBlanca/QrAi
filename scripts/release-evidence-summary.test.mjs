import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const summaryScript = fileURLToPath(new URL("./release-evidence-summary.mjs", import.meta.url));

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function prepareCandidate(t) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-release-summary-repo-"));
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "qrai-release-summary-evidence-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));
  writeFileSync(join(repo, "candidate.txt"), "release candidate\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Release Summary Test"]);
  git(repo, ["config", "user.email", "release-summary@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);
  return {
    repo,
    evidenceDirectory,
    candidateSha: git(repo, ["rev-parse", "HEAD"]),
    testOutput: join(evidenceDirectory, "test-summary.json"),
    environmentOutput: join(evidenceDirectory, "environment-summary.json"),
    smokeArtifactDirectory: join(evidenceDirectory, "smoke")
  };
}

function run(candidate, extra = []) {
  const result = spawnSync(process.execPath, [
    summaryScript,
    "--test-output",
    candidate.testOutput,
    "--environment-output",
    candidate.environmentOutput,
    "--environment-class",
    "ci",
    "--environment-provider",
    "release-evidence-test",
    "--smoke-artifact-dir",
    candidate.smokeArtifactDirectory,
    ...extra
  ], { cwd: candidate.repo, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.output);
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, pattern);
}

test("writes candidate-bound passed test and environment summaries outside the checkout", (t) => {
  const candidate = prepareCandidate(t);
  assertSuccess(run(candidate));

  const testSummary = JSON.parse(readFileSync(candidate.testOutput, "utf8"));
  const environmentSummary = JSON.parse(readFileSync(candidate.environmentOutput, "utf8"));
  assert.deepEqual(testSummary, {
    schemaVersion: "qrai-test-summary/v1",
    candidateSha: candidate.candidateSha,
    status: "passed",
    command: "bash scripts/verify.sh --release",
    completedAt: testSummary.completedAt
  });
  assert.deepEqual(environmentSummary, {
    schemaVersion: "qrai-environment-summary/v1",
    candidateSha: candidate.candidateSha,
    status: "passed",
    class: "ci",
    provider: "release-evidence-test",
    completedAt: environmentSummary.completedAt
  });
  assert.equal(new Date(testSummary.completedAt).toISOString(), testSummary.completedAt);
  assert.equal(new Date(environmentSummary.completedAt).toISOString(), environmentSummary.completedAt);
});

test("refuses evidence output inside the candidate checkout", (t) => {
  const candidate = prepareCandidate(t);
  candidate.testOutput = join(candidate.repo, "test-summary.json");

  assertFailure(run(candidate), /must be outside the candidate checkout/i);
});

test("refuses a smoke artifact directory inside the candidate checkout", (t) => {
  const candidate = prepareCandidate(t);
  candidate.smokeArtifactDirectory = join(candidate.repo, "out", "smoke");

  assertFailure(run(candidate), /must be outside the candidate checkout/i);
});

test("refuses to claim a dirty checkout passed release verification", (t) => {
  const candidate = prepareCandidate(t);
  writeFileSync(join(candidate.repo, "untracked.txt"), "not a release candidate\n");

  assertFailure(run(candidate), /untracked or modified files/i);
});

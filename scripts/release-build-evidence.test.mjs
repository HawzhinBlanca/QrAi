import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const buildEvidenceScript = fileURLToPath(new URL("./release-build-evidence.mjs", import.meta.url));
const services = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function imageDigests() {
  return Object.fromEntries(services.map((service, index) => [service, `sha256:${String(index + 1).repeat(64)}`]));
}

function prepareCandidate(t) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-release-build-repo-"));
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "qrai-release-build-evidence-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));
  writeFileSync(join(repo, "candidate.txt"), "release candidate\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Release Build Test"]);
  git(repo, ["config", "user.email", "release-build@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);
  const imageDigestPath = join(evidenceDirectory, "image-digests.json");
  writeFileSync(imageDigestPath, JSON.stringify(imageDigests()));
  return {
    repo,
    evidenceDirectory,
    candidateSha: git(repo, ["rev-parse", "HEAD"]),
    imageDigestPath,
    summaryOutput: join(evidenceDirectory, "build-summary.json"),
    provenanceOutput: join(evidenceDirectory, "build-provenance.json"),
  };
}

function run(candidate) {
  const result = spawnSync(process.execPath, [
    buildEvidenceScript,
    "--summary-output", candidate.summaryOutput,
    "--provenance-output", candidate.provenanceOutput,
    "--image-digests", candidate.imageDigestPath,
    "--builder-id", "github-actions/release",
    "--invocation-id", "run-1234",
    "--command", "docker buildx bake --push",
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

test("writes external build summary and provenance bound to one clean candidate and image digests", (t) => {
  const candidate = prepareCandidate(t);
  assertSuccess(run(candidate));

  const summary = JSON.parse(readFileSync(candidate.summaryOutput, "utf8"));
  const provenance = JSON.parse(readFileSync(candidate.provenanceOutput, "utf8"));
  assert.equal(summary.schemaVersion, "qrai-build-summary/v1");
  assert.equal(provenance.schemaVersion, "qrai-build-provenance/v1");
  assert.equal(summary.candidateSha, candidate.candidateSha);
  assert.equal(provenance.candidateSha, candidate.candidateSha);
  assert.deepEqual(summary.imageDigests, imageDigests());
  assert.deepEqual(provenance.imageDigests, imageDigests());
  assert.equal(summary.provenance.builderId, "github-actions/release");
  assert.equal(summary.provenance.invocationId, "run-1234");
  assert.match(summary.provenance.sha256, /^[a-f0-9]{64}$/);
});

test("refuses build evidence output inside the candidate checkout", (t) => {
  const candidate = prepareCandidate(t);
  candidate.summaryOutput = join(candidate.repo, "build-summary.json");
  assertFailure(run(candidate), /must be outside the candidate checkout/i);
});

test("refuses dirty source or incomplete image digests", (t) => {
  const candidate = prepareCandidate(t);
  writeFileSync(join(candidate.repo, "untracked.txt"), "not a release candidate\n");
  assertFailure(run(candidate), /untracked or modified files/i);

  const cleanCandidate = prepareCandidate(t);
  const incomplete = imageDigests();
  delete incomplete.web;
  writeFileSync(cleanCandidate.imageDigestPath, JSON.stringify(incomplete));
  assertFailure(run(cleanCandidate), /imageDigests\.web/i);
});

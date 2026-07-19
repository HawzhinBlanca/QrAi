import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCandidateBoundSmokeSummary } from "./smoke-evidence.mjs";

const deployableServices = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function prepareCandidate(t) {
  const repo = mkdtempSync(join(tmpdir(), "qrai-smoke-evidence-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "smoke-runner.mjs"), "export const smoke = true;\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Smoke Evidence Test"]);
  git(repo, ["config", "user.email", "smoke-evidence@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "candidate source"]);
  return { repo, candidateSha: git(repo, ["rev-parse", "HEAD"]) };
}

function imageDigests() {
  return Object.fromEntries(deployableServices.map((service, index) => [service, `sha256:${String(index + 1).repeat(64)}`]));
}

function passedInput(candidate, overrides = {}) {
  return {
    repositoryRoot: candidate.repo,
    candidateSha: candidate.candidateSha,
    expectedCandidateSha: candidate.candidateSha,
    traceId: "release-trace-smoke-evidence-0001",
    startedAt: "2026-07-19T10:00:00.000Z",
    completedAt: "2026-07-19T10:02:00.000Z",
    artifactRoot: "/external/release-smoke",
    status: "passed",
    results: [{ step: "smoke:sql", status: "passed", exitCode: 0 }],
    failures: [],
    environment: { class: "ci", provider: "release-test" },
    testActorClass: "release-automation",
    imageDigests: imageDigests(),
    requireDeployableImages: true,
    scriptFiles: ["smoke-runner.mjs"],
    ...overrides
  };
}

test("binds a passed aggregate smoke summary to the exact candidate, trace, environment, images, and scripts", (t) => {
  const candidate = prepareCandidate(t);
  const summary = createCandidateBoundSmokeSummary(passedInput(candidate));

  assert.equal(summary.schemaVersion, "qrai-smoke-summary/v1");
  assert.equal(summary.candidateSha, candidate.candidateSha);
  assert.equal(summary.traceId, "release-trace-smoke-evidence-0001");
  assert.equal(summary.status, "passed");
  assert.deepEqual(summary.environment, { class: "ci", provider: "release-test" });
  assert.equal(summary.testActorClass, "release-automation");
  assert.deepEqual(summary.imageDigests, imageDigests());
  assert.match(summary.scriptHashes["smoke-runner.mjs"], /^[a-f0-9]{64}$/);
});

test("fails closed when the requested candidate identity does not match the checkout", (t) => {
  const candidate = prepareCandidate(t);
  assert.throws(
    () => createCandidateBoundSmokeSummary(passedInput(candidate, { expectedCandidateSha: "a".repeat(40) })),
    /does not match the checkout/i,
  );
});

test("fails closed when release smoke is missing a deployable image digest", (t) => {
  const candidate = prepareCandidate(t);
  const digests = imageDigests();
  delete digests.web;
  assert.throws(
    () => createCandidateBoundSmokeSummary(passedInput(candidate, { imageDigests: digests })),
    /imageDigests\.web/i,
  );
});

test("fails closed when release smoke uses a non-release trace", (t) => {
  const candidate = prepareCandidate(t);
  assert.throws(
    () => createCandidateBoundSmokeSummary(passedInput(candidate, {
      traceId: "smoke-trace-local-only",
      requireReleaseTrace: true,
    })),
    /release trace/i,
  );
});

test("refuses to label a smoke run passed when a recorded stage failed", (t) => {
  const candidate = prepareCandidate(t);
  assert.throws(
    () => createCandidateBoundSmokeSummary(passedInput(candidate, {
      results: [{ step: "smoke:browser", status: "failed", exitCode: 1 }],
      failures: [{ step: "smoke:browser", exitCode: 1 }],
    })),
    /passed smoke summary cannot contain failed stages/i,
  );
});

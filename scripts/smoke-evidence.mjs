import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const candidatePattern = /^[a-f0-9]{40}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const releaseTracePattern = /^release-trace-[a-z0-9][a-z0-9-]{15,127}$/;
const deployableServices = ["platform-api", "realtime-gateway", "ml-inference", "asr-inference", "web"];

function fail(message) {
  throw new Error(message);
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function getCheckoutCandidateSha(repositoryRoot) {
  const sha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  assertCandidate(sha, "checkout candidate SHA");
  return sha;
}

export function assertExpectedCandidateSha(repositoryRoot, expectedCandidateSha) {
  const currentCandidateSha = getCheckoutCandidateSha(repositoryRoot);
  assertCandidate(expectedCandidateSha, "expectedCandidateSha");
  if (expectedCandidateSha !== currentCandidateSha) {
    fail("Requested smoke candidate does not match the checkout.");
  }
  return currentCandidateSha;
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be an ISO-8601 timestamp.`);
  }
}

function assertCandidate(value, label) {
  if (typeof value !== "string" || !candidatePattern.test(value)) {
    fail(`${label} must be a full lowercase Git SHA.`);
  }
}

function assertText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required.`);
  }
}

function assertImageDigests(imageDigests, required) {
  if (!imageDigests || typeof imageDigests !== "object" || Array.isArray(imageDigests)) {
    fail("imageDigests must be an object.");
  }
  const requiredServices = required ? deployableServices : Object.keys(imageDigests);
  for (const service of requiredServices) {
    if (typeof imageDigests[service] !== "string" || !imageDigestPattern.test(imageDigests[service])) {
      fail(`imageDigests.${service} must be a non-empty sha256 digest.`);
    }
  }
}

function scriptHashes(repositoryRoot, scriptFiles) {
  if (!Array.isArray(scriptFiles) || scriptFiles.length === 0) {
    fail("scriptFiles must list the smoke scripts that produced the evidence.");
  }
  const hashes = {};
  for (const scriptFile of scriptFiles) {
    if (typeof scriptFile !== "string" || scriptFile.trim() === "" || isAbsolute(scriptFile)) {
      fail("scriptFiles must contain non-empty relative paths.");
    }
    const source = readFileSync(resolve(repositoryRoot, scriptFile));
    hashes[scriptFile] = createHash("sha256").update(source).digest("hex");
  }
  return hashes;
}

function assertResultIntegrity(status, results, failures) {
  if (!Array.isArray(results) || results.length === 0) {
    fail("Smoke evidence must contain at least one recorded stage.");
  }
  if (!Array.isArray(failures)) {
    fail("Smoke evidence failures must be an array.");
  }
  const hasFailedStage = results.some((result) => result?.status === "failed");
  if (status === "passed" && (hasFailedStage || failures.length !== 0)) {
    fail("Passed smoke summary cannot contain failed stages or failures.");
  }
  if (status === "failed" && !hasFailedStage && failures.length === 0) {
    fail("Failed smoke summary must record a failed stage or failure.");
  }
}

export function createCandidateBoundSmokeSummary({
  repositoryRoot,
  candidateSha,
  expectedCandidateSha,
  traceId,
  startedAt,
  completedAt,
  artifactRoot,
  status,
  results,
  failures,
  error,
  environment,
  testActorClass,
  imageDigests,
  requireDeployableImages = false,
  requireReleaseTrace = false,
  scriptFiles,
}) {
  const currentCandidateSha = getCheckoutCandidateSha(repositoryRoot);
  assertCandidate(candidateSha, "candidateSha");
  assertExpectedCandidateSha(repositoryRoot, expectedCandidateSha);
  if (candidateSha !== currentCandidateSha) {
    fail("Requested smoke candidate does not match the checkout.");
  }
  assertText(traceId, "traceId");
  if (requireReleaseTrace && !releaseTracePattern.test(traceId)) {
    fail("Release smoke traceId must be a release trace.");
  }
  assertIsoDate(startedAt, "startedAt");
  assertIsoDate(completedAt, "completedAt");
  assertText(artifactRoot, "artifactRoot");
  if (status !== "passed" && status !== "failed") {
    fail("Smoke status must be passed or failed.");
  }
  if (!environment || typeof environment !== "object") {
    fail("environment is required.");
  }
  assertText(environment.class, "environment.class");
  assertText(environment.provider, "environment.provider");
  assertText(testActorClass, "testActorClass");
  assertImageDigests(imageDigests, requireDeployableImages);
  assertResultIntegrity(status, results, failures);

  return {
    schemaVersion: "qrai-smoke-summary/v1",
    candidateSha: currentCandidateSha,
    status,
    command: "pnpm smoke:all",
    startedAt,
    completedAt,
    artifactRoot,
    traceId,
    environment: { class: environment.class, provider: environment.provider },
    testActorClass,
    imageDigests,
    scriptHashes: scriptHashes(repositoryRoot, scriptFiles),
    results,
    failures,
    ...(error ? { error } : {}),
  };
}

export function parseImageDigests(value, { required = false } = {}) {
  if (!value) {
    if (required) fail("SMOKE_IMAGE_DIGESTS_JSON is required for release smoke.");
    return {};
  }
  let imageDigests;
  try {
    imageDigests = JSON.parse(value);
  } catch {
    fail("SMOKE_IMAGE_DIGESTS_JSON must be valid JSON.");
  }
  assertImageDigests(imageDigests, required);
  return imageDigests;
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";
import {
  HttpCanaryControllerError,
  assertHttpCanaryControllerEvidence,
  httpCanaryControllerCommandPlan,
  runHttpCanaryController,
} from "../../scripts/lib/http-canary-controller.mjs";
import { createReleaseDeploymentSelection } from "../../scripts/lib/release-deployment.mjs";
import { runHttpCanaryRollbackProbe } from "../../scripts/lib/http-canary-rollback-probe.mjs";

const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const hash = (character) => `sha256:${character.repeat(64)}`;

function imageDigests(seed) {
  return Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [key, hash(String(seed + index))]),
  );
}

function selection() {
  return createReleaseDeploymentSelection({
    candidateSha,
    candidateImageDigests: imageDigests(1),
    previousSha,
    previousImageDigests: imageDigests(2),
    namespace: "exampleowner",
    createdAt: "2026-08-08T09:00:00.000Z",
  });
}

function healthyObservation() {
  return {
    nodeReady: true,
    workerReady: true,
    rustReady: true,
    httpErrorRate: 0,
    httpP95Ms: 250,
    fallbackShare: 0.01,
    jobQueued: 2,
    jobRetry: 0,
    jobDead: 0,
    privacyFailures: 0,
    tenantIsolationFailures: 0,
    lostChunks: 0,
    feedbackLeaks: 0,
  };
}

function operationResult(label) {
  return { commandSha256: hash(label), outputSha256: hash(label === "a" ? "b" : "c") };
}

function context({ failDeploy = false } = {}) {
  let tick = 0;
  const calls = [];
  const operations = {
    async reverseTraffic() { calls.push("reverseTraffic"); return operationResult("a"); },
    async deployPrevious() {
      calls.push("deployPrevious");
      if (failDeploy) throw new Error("planned deploy failure");
      return operationResult("b");
    },
    async verifyPrevious() {
      calls.push("verifyPrevious");
      return {
        ...operationResult("c"),
        applicationImagesVerified: 7,
        storedEffects: 1,
        duplicateEffects: 0,
        privacyCleanup: "passed",
      };
    },
  };
  return {
    calls,
    args: {
      selection: selection(),
      sourceSha: candidateSha,
      runClass: "observation",
      candidateEvidenceSha256: hash("d"),
      loadEvidenceSha256: hash("e"),
      observation: healthyObservation(),
      operations,
      now: () => new Date(Date.parse("2026-08-08T09:10:00.000Z") + tick++ * 1000).toISOString(),
    },
  };
}

test("a healthy observation never auto-promotes and performs no mutation", async () => {
  const { args, calls } = context();
  const evidence = await runHttpCanaryController(args);
  assert.equal(evidence.status, "awaiting-human-promotion");
  assert.deepEqual(evidence.stopSignals, []);
  assert.deepEqual(calls, []);
  assertHttpCanaryControllerEvidence(evidence);
  const nonMonotonic = structuredClone(evidence);
  nonMonotonic.transitions[1].at = "2026-08-08T09:09:59.999Z";
  assert.throws(() => assertHttpCanaryControllerEvidence(nonMonotonic), /transition.*window|monotonic/i);
});

test("any stop signal reverses traffic, deploys previous digests, and verifies effects in order", async () => {
  const { args, calls } = context();
  args.runClass = "deliberate-drill";
  args.observation = { ...healthyObservation(), tenantIsolationFailures: 1 };
  const evidence = await runHttpCanaryController(args);
  assert.equal(evidence.status, "rollback-complete");
  assert.deepEqual(evidence.stopSignals, ["tenant-isolation-failure"]);
  assert.deepEqual(calls, ["reverseTraffic", "deployPrevious", "verifyPrevious"]);
  assert.equal(evidence.rollback.verification.duplicateEffects, 0);
  assert.equal(evidence.rollback.verification.storedEffects, 1);
  assert.equal(evidence.rollback.verification.privacyCleanup, "passed");
  assertHttpCanaryControllerEvidence(evidence);
});

test("a failed rollback stays failed evidence and never proceeds past the failed operation", async () => {
  const { args, calls } = context({ failDeploy: true });
  args.runClass = "incident";
  args.observation = { ...healthyObservation(), jobDead: 1 };
  await assert.rejects(
    () => runHttpCanaryController(args),
    (error) => {
      assert.ok(error instanceof HttpCanaryControllerError);
      assert.equal(error.evidence.status, "rollback-failed");
      assert.match(error.evidence.failure, /previous deployment failed/);
      assert.equal(error.cause?.message, "planned deploy failure");
      assertHttpCanaryControllerEvidence(error.evidence);
      const forged = structuredClone(error.evidence);
      forged.rollback.verification = {
        ...operationResult("c"),
        applicationImagesVerified: 7,
        storedEffects: 1,
        duplicateEffects: 0,
        privacyCleanup: "passed",
      };
      assert.throws(
        () => assertHttpCanaryControllerEvidence(forged),
        /failed rollback evidence.*exactly/i,
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["reverseTraffic", "deployPrevious"]);
});

test("release rollback proof distinguishes a deliberate drill from a real incident", async () => {
  const { args } = context();
  args.observation = { ...healthyObservation(), jobDead: 1 };
  await assert.rejects(() => runHttpCanaryController(args), /runClass.*stop signal/i);
  args.runClass = "deliberate-drill";
  assert.equal((await runHttpCanaryController(args)).runClass, "deliberate-drill");
});

test("the operator plan reverses Web and gateway together, restores seven apps, and never rolls back migrations", () => {
  const plan = httpCanaryControllerCommandPlan({ projectName: "qrai-canary" });
  assert.deepEqual(plan.reverseTraffic.slice(-3), ["node-api", "realtime-gateway", "web"]);
  assert.deepEqual(plan.deployPrevious.slice(-7), [
    "platform-api",
    "node-api",
    "job-worker",
    "node-realtime",
    "realtime-gateway",
    "asr-inference",
    "web",
  ]);
  assert.match(plan.verifyPrevious.join(" "), /release-deployment\.mjs verify.*--scope application/);
  const rendered = JSON.stringify(plan);
  assert.doesNotMatch(rendered, /docker-compose\.canary\.yml|migrations|--build|docker build/);
});

test("rollback effect proof measures one stored effect and verifies privacy cleanup", async () => {
  const requests = [];
  const states = [
    { rowCount: 1, repetitions: 1 },
    { rowCount: 0, repetitions: null },
  ];
  const result = await runHttpCanaryRollbackProbe({
    baseUrl: "https://rollback.example.test",
    jwtSecret: "unit-test-secret",
    databaseUrl: "postgresql://unused.example/test",
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url).pathname;
      requests.push({ path, init });
      if (path === "/health") return new Response("ok", { status: 200 });
      if (path === "/v1/learner/progress") {
        return Response.json({ sm2State: { repetitions: 1 } });
      }
      if (path === "/v1/privacy/delete") {
        return Response.json({ deletedRecords: ["progress"] });
      }
      return new Response("not found", { status: 404 });
    },
    readProgressState: async () => states.shift(),
  });

  assert.deepEqual(result, {
    applicationHealth: "passed",
    storedEffects: 1,
    duplicateEffects: 0,
    privacyCleanup: "passed",
  });
  assert.deepEqual(requests.map(({ path }) => path), [
    "/health",
    "/v1/learner/progress",
    "/v1/privacy/delete",
  ]);
  assert.ok(requests.slice(1).every(({ init }) => init.headers.authorization.startsWith("Bearer ")));
});

test("rollback effect proof fails closed when one request leaves more than one stored effect", async () => {
  await assert.rejects(
    () => runHttpCanaryRollbackProbe({
      baseUrl: "https://rollback.example.test",
      jwtSecret: "unit-test-secret",
      databaseUrl: "postgresql://unused.example/test",
      fetchImpl: async (url) => new URL(url).pathname === "/health"
        ? new Response("ok", { status: 200 })
        : Response.json({ sm2State: { repetitions: 1 }, deletedRecords: ["progress"] }),
      readProgressState: async () => ({ rowCount: 1, repetitions: 2 }),
    }),
    /exactly one stored effect/,
  );
});

test("the one-shot operator validates all candidate proofs, runs the controller, and writes evidence once", () => {
  const source = readFileSync("scripts/http-canary-controller.mjs", "utf8");
  assert.match(source, /assertHttpCanaryImageEvidenceForPromotion/);
  assert.match(source, /assertCanaryLoadEvidenceSetForPromotion/);
  for (const flag of [
    "--run-class",
    "--classroom-load-evidence",
    "--burst-load-evidence",
    "--soak-load-evidence",
  ]) {
    assert.match(source, new RegExp(flag));
  }
  assert.match(source, /runHttpCanaryController/);
  assert.match(source, /runHttpCanaryRollbackProbe/);
  assert.match(source, /composeImageEnvironment\(selection, "candidate"\)/);
  assert.match(source, /composeImageEnvironment\(selection, "previous"\)/);
  assert.match(source, /flag:\s*"wx"/);
  assert.doesNotMatch(source, /docker-compose\.canary\.yml|migrations|--build|docker build/);
});

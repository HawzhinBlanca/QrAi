import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANARY_LOAD_PROFILES,
  CANARY_LOAD_THRESHOLDS,
  assertCanaryLoadEvidenceForPromotion,
  assertCanaryLoadEvidenceSetForPromotion,
  createCanaryLoadEvidence,
} from "./lib/canary-load-evidence.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = (character) => `sha256:${character.repeat(64)}`;

function input() {
  return {
    sourceSha: sha,
    nodeImageId: digest("a"),
    topologySha256: digest("b"),
    profile: "classroom",
    startedAt: "2026-08-08T09:00:00.000Z",
    completedAt: "2026-08-08T09:05:00.000Z",
    metrics: {
      httpP95Ms: 450,
      errorRate: 0,
      checksRate: 1,
      totalRequests: 3000,
      droppedIterations: 0,
    },
    thresholds: Object.fromEntries(
      Object.keys(CANARY_LOAD_THRESHOLDS).map((key) => [key, true]),
    ),
  };
}

test("load profiles and thresholds are closed, immutable release policy", () => {
  assert.deepEqual(Object.keys(CANARY_LOAD_PROFILES), ["classroom", "burst", "soak"]);
  assert.deepEqual(CANARY_LOAD_THRESHOLDS, {
    http_req_duration: "p(95)<1000",
    errors: "rate<0.01",
    checks: "rate>0.99",
    dropped_iterations: "count==0",
  });
  assert.ok(Object.isFrozen(CANARY_LOAD_PROFILES));
  assert.ok(Object.isFrozen(CANARY_LOAD_THRESHOLDS));
});

test("load evidence binds the candidate image and topology and preserves a failed threshold", () => {
  const passed = createCanaryLoadEvidence(input());
  assert.equal(passed.status, "passed");
  assert.equal(assertCanaryLoadEvidenceForPromotion(passed).sourceSha, sha);

  const failedInput = structuredClone(input());
  failedInput.thresholds.errors = false;
  failedInput.metrics.errorRate = 0.02;
  const failed = createCanaryLoadEvidence(failedInput);
  assert.equal(failed.status, "failed");
  assert.throws(() => assertCanaryLoadEvidenceForPromotion(failed), /failed load evidence/);
  const dishonest = structuredClone(input());
  dishonest.metrics.errorRate = 0.02;
  assert.throws(
    () => createCanaryLoadEvidence(dishonest),
    /thresholds.*measured metrics/i,
  );
  assert.throws(
    () => createCanaryLoadEvidence({ ...input(), nodeImageId: "source-process" }),
    /nodeImageId/,
  );
});

test("promotion requires one passed, identity-matched load proof for every approved profile", () => {
  const completedAt = {
    classroom: "2026-08-08T09:05:00.000Z",
    burst: "2026-08-08T09:02:00.000Z",
    soak: "2026-08-08T09:30:00.000Z",
  };
  const totalRequests = { classroom: 3000, burst: 4500, soak: 9000 };
  const set = Object.fromEntries(
    Object.keys(CANARY_LOAD_PROFILES).map((profile) => [
      profile,
      createCanaryLoadEvidence({
        ...input(),
        profile,
        completedAt: completedAt[profile],
        metrics: { ...input().metrics, totalRequests: totalRequests[profile] },
      }),
    ]),
  );
  const accepted = assertCanaryLoadEvidenceSetForPromotion(set, {
    sourceSha: sha,
    nodeImageId: digest("a"),
    topologySha256: digest("b"),
  }, { validatedAt: "2026-08-08T09:31:00.000Z" });
  assert.deepEqual(Object.keys(accepted), ["classroom", "burst", "soak"]);

  const missing = structuredClone(set);
  delete missing.soak;
  assert.throws(
    () => assertCanaryLoadEvidenceSetForPromotion(missing, {
      sourceSha: sha,
      nodeImageId: digest("a"),
      topologySha256: digest("b"),
    }, { validatedAt: "2026-08-08T09:31:00.000Z" }),
    /exactly: burst, classroom, soak/i,
  );
  const substituted = structuredClone(set);
  substituted.burst.nodeImageId = digest("c");
  assert.throws(
    () => assertCanaryLoadEvidenceSetForPromotion(substituted, {
      sourceSha: sha,
      nodeImageId: digest("a"),
      topologySha256: digest("b"),
    }, { validatedAt: "2026-08-08T09:31:00.000Z" }),
    /nodeImageId.*candidate/i,
  );
  assert.throws(
    () => createCanaryLoadEvidence({
      ...input(),
      profile: "soak",
      completedAt: "2026-08-08T09:29:59.999Z",
    }),
    /soak.*30m/i,
  );
  assert.throws(
    () => createCanaryLoadEvidence({
      ...input(),
      profile: "soak",
      completedAt: "2026-08-08T09:30:00.000Z",
    }),
    /soak.*9000.*requests/i,
  );
  assert.throws(
    () => assertCanaryLoadEvidenceSetForPromotion(set, {
      sourceSha: sha,
      nodeImageId: digest("a"),
      topologySha256: digest("b"),
    }, { validatedAt: "2026-08-09T09:31:00.000Z" }),
    /load evidence.*expired/i,
  );
});

test("k6 targets an explicit candidate and real worker with classroom, burst, and soak scenarios", () => {
  const source = readFileSync("scripts/load-test.js", "utf8");
  assert.match(source, /__ENV\[name\]/);
  assert.match(source, /httpTarget\("CANDIDATE_HTTP"\)/);
  assert.match(source, /httpTarget\("JOB_WORKER_HTTP"\)/);
  assert.match(source, /required\("CANARY_BEARER_TOKEN"\)/);
  assert.match(source, /CANARY_LOAD_PROFILES/);
  assert.match(source, /createCanaryLoadEvidence/);
  assert.match(source, /recitation-sessions/);
  assert.match(source, /finalize/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8080|smoke-ml-api-key/);
  assert.doesNotMatch(source, /CANARY_BEARER_TOKEN[^\n]*(console|summary|JSON)/);
});

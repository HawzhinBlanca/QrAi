import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANARY_LOAD_PROFILES,
  CANARY_LOAD_THRESHOLDS,
  createCanaryLoadEvidence,
} from "../../scripts/lib/canary-load-evidence.mjs";
import { DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";
import {
  assertHttpCanaryControllerEvidence,
  evaluateHttpCanaryObservation,
  runHttpCanaryController,
} from "../../scripts/lib/http-canary-controller.mjs";
import {
  REQUIRED_HTTP_CANARY_IMAGE_STAGES,
  createHttpCanaryImageEvidence,
} from "../../scripts/lib/http-canary-image.mjs";
import { loadHttpCanaryRouteKeys } from "../../scripts/lib/http-canary-probe.mjs";
import {
  HTTP_CANARY_REQUIRED_REMOTE_CHECKS,
  assertHttpCanaryReleaseEvidenceDocuments,
  canonicalizeHttpCanaryReleasePayload,
  httpCanaryEvidenceTextSha256,
  httpCanaryLoadEvidenceTextsSha256,
} from "../../scripts/lib/http-canary-release-evidence.mjs";
import {
  composeImageEnvironment,
  createReleaseDeploymentSelection,
} from "../../scripts/lib/release-deployment.mjs";

const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const validatedAt = "2026-08-08T10:00:00.000Z";
const digest = (character) => `sha256:${character.repeat(64)}`;

function digests(seed) {
  return Object.fromEntries(DEPLOYABLE_IMAGE_KEYS.map((key, index) => [
    key,
    digest((seed + index).toString(16)),
  ]));
}

function deploymentSelection() {
  return createReleaseDeploymentSelection({
    candidateSha,
    candidateImageDigests: digests(1),
    previousSha,
    previousImageDigests: digests(8),
    namespace: "exampleowner",
    createdAt: "2026-08-08T07:50:00.000Z",
  });
}

function candidateEvidence(selection) {
  const environment = composeImageEnvironment(selection, "candidate");
  const references = {
    "platform-api": environment.PLATFORM_API_IMAGE,
    "node-api": environment.NODE_BACKEND_IMAGE,
    "job-worker": environment.NODE_BACKEND_IMAGE,
    migrations: environment.MIGRATION_RUNNER_IMAGE,
    "realtime-gateway": environment.REALTIME_GATEWAY_IMAGE,
    "asr-inference": environment.ASR_INFERENCE_IMAGE,
    web: environment.WEB_IMAGE,
  };
  const ids = new Map();
  const images = Object.entries(references).map(([service, reference], index) => {
    if (!ids.has(reference)) ids.set(reference, digest((index + 1).toString(16)));
    return {
      service,
      containerId: `container-${index}`,
      reference,
      imageId: ids.get(reference),
    };
  });
  const stages = REQUIRED_HTTP_CANARY_IMAGE_STAGES.map((name, index) => ({
    name,
    status: "passed",
    startedAt: `2026-08-08T08:0${index}:00.000Z`,
    completedAt: `2026-08-08T08:0${index}:30.000Z`,
    commandSha256: digest((index + 1).toString(16)),
    outputSha256: digest((index + 2).toString(16)),
    ...(name === "rust-unavailable-routes" ? {
      details: {
        rustRunning: false,
        retainedAttempted: 39,
        retainedFallbacks: 0,
        transitionAttempted: 4,
        transitionDependencyFailures: 4,
      },
    } : {}),
  }));
  return createHttpCanaryImageEvidence({
    sourceState: { headSha: candidateSha, clean: true },
    selection,
    environment: { class: "staging-isolated", provider: "protected-staging" },
    actorClass: "release-operator",
    evidenceClass: "live-candidate",
    executionMode: "immutable-compose-images",
    startedAt: "2026-08-08T08:00:00.000Z",
    completedAt: "2026-08-08T08:10:00.000Z",
    expiresAt: "2026-08-09T08:10:00.000Z",
    topology: {
      renderedSha256: digest("a"),
      webTarget: "node-api:8082",
      gatewayTarget: "http://node-api:8082",
      nodeRouteMode: "retained-canary",
      rustUpstream: "http://platform-api:8080",
    },
    routeKeys: loadHttpCanaryRouteKeys(),
    images,
    stages,
    validatedAt: "2026-08-08T08:10:00.000Z",
  });
}

function loadEvidenceTexts(nodeImageId) {
  const completedAt = {
    classroom: "2026-08-08T08:20:00.000Z",
    burst: "2026-08-08T08:17:00.000Z",
    soak: "2026-08-08T08:45:00.000Z",
  };
  const totalRequests = { classroom: 3000, burst: 4500, soak: 9000 };
  return Object.fromEntries(Object.keys(CANARY_LOAD_PROFILES).map((profile) => [
    profile,
    `${JSON.stringify(createCanaryLoadEvidence({
      sourceSha: candidateSha,
      nodeImageId,
      topologySha256: digest("a"),
      profile,
      startedAt: "2026-08-08T08:15:00.000Z",
      completedAt: completedAt[profile],
      metrics: {
        httpP95Ms: 300,
        errorRate: 0,
        checksRate: 1,
        totalRequests: totalRequests[profile],
        droppedIterations: 0,
      },
      thresholds: Object.fromEntries(
        Object.keys(CANARY_LOAD_THRESHOLDS).map((key) => [key, true]),
      ),
    }), null, 2)}\n`,
  ]));
}

function healthyObservation() {
  return {
    nodeReady: true,
    workerReady: true,
    rustReady: true,
    httpErrorRate: 0,
    httpP95Ms: 300,
    fallbackShare: 0,
    jobQueued: 0,
    jobRetry: 0,
    jobDead: 0,
    privacyFailures: 0,
    tenantIsolationFailures: 0,
    lostChunks: 0,
    feedbackLeaks: 0,
  };
}

function operationResult(character) {
  return { commandSha256: digest(character), outputSha256: digest(character === "b" ? "c" : "d") };
}

function clock(start, count = 12) {
  const values = Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(start) + index * 1000).toISOString());
  return () => values.shift();
}

function keyring() {
  const roles = ["ci-attestor", "monitoring-attestor", "release-owner", "security", "sre"];
  const signers = Object.fromEntries(roles.map((role) => {
    const pair = generateKeyPairSync("ed25519");
    return [role, { keyId: `${role}-key`, ...pair }];
  }));
  return {
    signers,
    policy: {
      schemaVersion: "qrai-http-canary-trust-policy/v1",
      policyId: "protected-release-authority-v1",
      repository: "exampleowner/qrai",
      keys: roles.map((role) => ({
        keyId: signers[role].keyId,
        algorithm: "Ed25519",
        role,
        status: "active",
        publicKeyJwk: signers[role].publicKey.export({ format: "jwk" }),
      })),
    },
  };
}

function signedBundle(schemaVersion, payload, signer, signedAt) {
  const bytes = Buffer.from(canonicalizeHttpCanaryReleasePayload(payload), "utf8");
  return {
    schemaVersion,
    payload,
    signature: {
      keyId: signer.keyId,
      algorithm: "Ed25519",
      payloadSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      signatureBase64Url: sign(null, bytes, signer.privateKey).toString("base64url"),
      signedAt,
    },
  };
}

async function releaseDocuments() {
  const selection = deploymentSelection();
  const candidate = candidateEvidence(selection);
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  const nodeImageId = candidate.images.find(({ service }) => service === "node-api").imageId;
  const loads = loadEvidenceTexts(nodeImageId);
  const candidateEvidenceSha256 = httpCanaryEvidenceTextSha256(candidateText);
  const loadEvidenceSha256 = httpCanaryLoadEvidenceTextsSha256(loads);
  const { signers, policy } = keyring();
  const observationPayload = {
    schemaVersion: "qrai-http-canary-observation/v1",
    candidateSha,
    nodeImageId,
    topologySha256: digest("a"),
    source: "prometheus-and-active-probes",
    startedAt: "2026-08-08T08:45:00.000Z",
    completedAt: "2026-08-08T09:00:00.000Z",
    expiresAt: "2026-08-09T09:00:00.000Z",
    metricQueriesSha256: digest("b"),
    activeProbeResultsSha256: digest("c"),
    observation: healthyObservation(),
  };
  const observationBundle = signedBundle(
    "qrai-http-canary-observation-bundle/v1",
    observationPayload,
    signers["monitoring-attestor"],
    "2026-08-08T09:00:10.000Z",
  );
  const operations = {
    reverseTraffic: async () => operationResult("d"),
    deployPrevious: async () => operationResult("e"),
    verifyPrevious: async () => ({
      ...operationResult("f"),
      applicationImagesVerified: 6,
      storedEffects: 1,
      duplicateEffects: 0,
      privacyCleanup: "passed",
    }),
  };
  const healthy = await runHttpCanaryController({
    selection,
    sourceSha: candidateSha,
    runClass: "observation",
    candidateEvidenceSha256,
    loadEvidenceSha256,
    observation: healthyObservation(),
    operations,
    now: clock("2026-08-08T09:01:00.000Z"),
  });
  const rollback = await runHttpCanaryController({
    selection,
    sourceSha: candidateSha,
    runClass: "deliberate-drill",
    candidateEvidenceSha256,
    loadEvidenceSha256,
    observation: { ...healthyObservation(), jobDead: 1 },
    operations,
    now: clock("2026-08-08T09:02:00.000Z"),
  });
  const healthyText = `${JSON.stringify(healthy, null, 2)}\n`;
  const rollbackText = `${JSON.stringify(rollback, null, 2)}\n`;
  const remoteCiPayload = {
    schemaVersion: "qrai-http-canary-remote-ci/v1",
    candidateSha,
    repository: "exampleowner/qrai",
    runId: "123456789",
    runAttempt: 1,
    runUrl: "https://github.com/exampleowner/qrai/actions/runs/123456789",
    event: "workflow_dispatch",
    completedAt: "2026-08-08T09:10:00.000Z",
    expiresAt: "2026-08-09T09:10:00.000Z",
    checks: HTTP_CANARY_REQUIRED_REMOTE_CHECKS.map((name) => ({ name, conclusion: "success" })),
  };
  const remoteCiBundle = signedBundle(
    "qrai-http-canary-remote-ci-bundle/v1",
    remoteCiPayload,
    signers["ci-attestor"],
    "2026-08-08T09:10:10.000Z",
  );
  const approvalBase = {
    schemaVersion: "qrai-http-canary-approval/v1",
    decision: "approve",
    candidateSha,
    candidateEvidenceSha256,
    loadEvidenceSha256,
    observationEvidencePayloadSha256: observationBundle.signature.payloadSha256,
    healthyControllerEvidenceSha256: httpCanaryEvidenceTextSha256(healthyText),
    rollbackControllerEvidenceSha256: httpCanaryEvidenceTextSha256(rollbackText),
    remoteCiEvidencePayloadSha256: remoteCiBundle.signature.payloadSha256,
    approvedAt: "2026-08-08T09:11:00.000Z",
    expiresAt: "2026-08-09T09:11:00.000Z",
  };
  const approvals = Object.fromEntries(["release-owner", "security", "sre"].map((role) => [
    role,
    `${JSON.stringify(signedBundle(
      "qrai-http-canary-approval-bundle/v1",
      { ...approvalBase, role },
      signers[role],
      "2026-08-08T09:11:10.000Z",
    ), null, 2)}\n`,
  ]));
  return {
    documents: {
      candidateEvidenceText: candidateText,
      loadEvidenceTexts: loads,
      observationEvidenceText: `${JSON.stringify(observationBundle, null, 2)}\n`,
      healthyControllerEvidenceText: healthyText,
      rollbackControllerEvidenceText: rollbackText,
      remoteCiEvidenceText: `${JSON.stringify(remoteCiBundle, null, 2)}\n`,
      approvalEvidenceTexts: approvals,
      trustPolicy: policy,
    },
    signers,
  };
}

test("every approved stop threshold has a named deterministic signal", () => {
  const base = {
    nodeReady: true,
    workerReady: true,
    rustReady: true,
    httpErrorRate: 0,
    httpP95Ms: 0,
    fallbackShare: 0,
    jobQueued: 0,
    jobRetry: 0,
    jobDead: 0,
    privacyFailures: 0,
    tenantIsolationFailures: 0,
    lostChunks: 0,
    feedbackLeaks: 0,
  };
  const cases = [
    ["nodeReady", false, "node-unready"],
    ["workerReady", false, "worker-unready"],
    ["rustReady", false, "rust-unready"],
    ["httpErrorRate", 0.010001, "http-error-rate"],
    ["httpP95Ms", 1000.001, "http-latency"],
    ["fallbackShare", 0.050001, "fallback-share"],
    ["jobQueued", 101, "job-backlog"],
    ["jobRetry", 11, "job-retries"],
    ["jobDead", 1, "job-dead-letter"],
    ["privacyFailures", 1, "privacy-failure"],
    ["tenantIsolationFailures", 1, "tenant-isolation-failure"],
    ["lostChunks", 1, "lost-audio-chunk"],
    ["feedbackLeaks", 1, "learner-feedback-leak"],
  ];
  for (const [key, value, expected] of cases) {
    assert.deepEqual(evaluateHttpCanaryObservation({ ...base, [key]: value }), [expected]);
  }
});

test("passed-looking rollback evidence cannot omit previous verification or hide duplicates", () => {
  const invalid = {
    schemaVersion: "qrai-http-canary-controller-evidence/v1",
    status: "rollback-complete",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    runClass: "deliberate-drill",
    candidateEvidenceSha256: `sha256:${"a".repeat(64)}`,
    loadEvidenceSha256: `sha256:${"b".repeat(64)}`,
    selection: {},
    startedAt: "2026-08-08T09:00:00.000Z",
    completedAt: "2026-08-08T09:01:00.000Z",
    observation: {},
    stopSignals: ["job-dead-letter"],
    transitions: [],
    rollback: {
      verification: {
        applicationImagesVerified: 0,
        storedEffects: 0,
        duplicateEffects: 1,
        privacyCleanup: "failed",
      },
    },
  };
  assert.throws(() => assertHttpCanaryControllerEvidence(invalid), /selection|verification/);
});

test("the T5 release authority is closed over remote checks and signed document bytes", () => {
  assert.deepEqual(HTTP_CANARY_REQUIRED_REMOTE_CHECKS, [
    "ci/android",
    "ci/node-min",
    "ci/verify",
    "docker-build/build",
    "release-image/publish",
  ]);
  assert.equal(
    canonicalizeHttpCanaryReleasePayload({ z: 1, a: [true, "x"] }),
    '{"a":[true,"x"],"z":1}',
  );
  assert.throws(
    () => assertHttpCanaryReleaseEvidenceDocuments({}, {
      validatedAt: "2026-08-08T10:00:00.000Z",
      expectedCandidateSha: "0123456789abcdef0123456789abcdef01234567",
    }),
    /candidate image evidence/i,
  );
});

test("T5 accepts only one fresh candidate-bound chain with signed monitoring, CI, and independent approvals", async () => {
  const { documents } = await releaseDocuments();
  const result = assertHttpCanaryReleaseEvidenceDocuments(documents, {
    validatedAt,
    expectedCandidateSha: candidateSha,
  });
  assert.equal(result.schemaVersion, "qrai-http-canary-release-evidence/v1");
  assert.equal(result.status, "ready-for-manual-promotion");
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.previousSha, previousSha);
  assert.deepEqual(result.remoteCi.checks, HTTP_CANARY_REQUIRED_REMOTE_CHECKS);
  assert.deepEqual(result.approvals.map(({ role }) => role), [
    "release-owner",
    "security",
    "sre",
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.artifacts));
});

test("T5 refuses tampering, missing remote checks, incident-only rollback, and reused authority", async () => {
  const { documents, signers } = await releaseDocuments();

  const tamperedApproval = structuredClone(documents);
  const security = JSON.parse(tamperedApproval.approvalEvidenceTexts.security);
  security.payload.candidateSha = previousSha;
  tamperedApproval.approvalEvidenceTexts.security = JSON.stringify(security);
  assert.throws(
    () => assertHttpCanaryReleaseEvidenceDocuments(tamperedApproval, {
      validatedAt,
      expectedCandidateSha: candidateSha,
    }),
    /security approval evidence payload sha256/i,
  );

  const missingCheck = structuredClone(documents);
  const ci = JSON.parse(missingCheck.remoteCiEvidenceText);
  ci.payload.checks.pop();
  missingCheck.remoteCiEvidenceText = JSON.stringify(signedBundle(
    "qrai-http-canary-remote-ci-bundle/v1",
    ci.payload,
    signers["ci-attestor"],
    "2026-08-08T09:10:10.000Z",
  ));
  assert.throws(
    () => assertHttpCanaryReleaseEvidenceDocuments(missingCheck, {
      validatedAt,
      expectedCandidateSha: candidateSha,
    }),
    /exact ordered required check inventory/i,
  );

  const incidentOnly = structuredClone(documents);
  const rollback = JSON.parse(incidentOnly.rollbackControllerEvidenceText);
  rollback.runClass = "incident";
  incidentOnly.rollbackControllerEvidenceText = JSON.stringify(rollback);
  assert.throws(
    () => assertHttpCanaryReleaseEvidenceDocuments(incidentOnly, {
      validatedAt,
      expectedCandidateSha: candidateSha,
    }),
    /completed deliberate drill/i,
  );

  const reusedAuthority = structuredClone(documents);
  reusedAuthority.trustPolicy.keys.find(({ role }) => role === "sre").publicKeyJwk =
    reusedAuthority.trustPolicy.keys.find(({ role }) => role === "security").publicKeyJwk;
  assert.throws(
    () => assertHttpCanaryReleaseEvidenceDocuments(reusedAuthority, {
      validatedAt,
      expectedCandidateSha: candidateSha,
    }),
    /reuses public key material/i,
  );
});

test("release mode validates external T5 evidence before work and writes closure only after success", () => {
  const operator = readFileSync("scripts/http-canary-release-evidence.mjs", "utf8");
  for (const flag of [
    "--candidate-evidence",
    "--classroom-load-evidence",
    "--burst-load-evidence",
    "--soak-load-evidence",
    "--observation-evidence",
    "--healthy-controller-evidence",
    "--rollback-controller-evidence",
    "--remote-ci-evidence",
    "--owner-approval",
    "--security-approval",
    "--sre-approval",
    "--trust-policy",
  ]) {
    assert.match(operator, new RegExp(flag));
  }
  assert.match(operator, /--validate-only/);
  assert.match(operator, /status:\s*"ready-for-manual-promotion"/);
  assert.match(operator, /flag:\s*"wx"/);
  assert.match(operator, /status[\s\S]*--porcelain/);

  const gate = readFileSync("scripts/verify.sh", "utf8");
  for (const variable of [
    "RELEASE_HTTP_CANARY_CANDIDATE_EVIDENCE",
    "RELEASE_HTTP_CANARY_CLASSROOM_LOAD_EVIDENCE",
    "RELEASE_HTTP_CANARY_BURST_LOAD_EVIDENCE",
    "RELEASE_HTTP_CANARY_SOAK_LOAD_EVIDENCE",
    "RELEASE_HTTP_CANARY_OBSERVATION_EVIDENCE",
    "RELEASE_HTTP_CANARY_HEALTHY_CONTROLLER_EVIDENCE",
    "RELEASE_HTTP_CANARY_ROLLBACK_CONTROLLER_EVIDENCE",
    "RELEASE_HTTP_CANARY_REMOTE_CI_EVIDENCE",
    "RELEASE_HTTP_CANARY_OWNER_APPROVAL",
    "RELEASE_HTTP_CANARY_SECURITY_APPROVAL",
    "RELEASE_HTTP_CANARY_SRE_APPROVAL",
    "RELEASE_HTTP_CANARY_TRUST_POLICY",
    "RELEASE_HTTP_CANARY_CLOSURE_OUTPUT",
  ]) {
    assert.match(gate, new RegExp(variable));
  }
  assert.equal((gate.match(/http-canary-release-evidence\.mjs/g) ?? []).length, 2);
});

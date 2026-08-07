import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CANARY_LOAD_PROFILES,
  assertCanaryLoadEvidenceSetForPromotion,
} from "./canary-load-evidence.mjs";
import {
  assertHttpCanaryControllerEvidence,
  evaluateHttpCanaryObservation,
} from "./http-canary-controller.mjs";
import { assertHttpCanaryImageEvidenceForPromotion } from "./http-canary-image.mjs";

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const publicKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const repositoryPattern = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const oneDayMs = 24 * 60 * 60 * 1_000;
const minimumObservationMs = 15 * 60 * 1_000;

export const HTTP_CANARY_REQUIRED_REMOTE_CHECKS = Object.freeze([
  "ci/android",
  "ci/node-min",
  "ci/verify",
  "docker-build/build",
  "release-image/publish",
]);

const requiredTrustRoles = Object.freeze([
  "ci-attestor",
  "monitoring-attestor",
  "release-owner",
  "security",
  "sre",
]);
const approvalRoles = Object.freeze(["release-owner", "security", "sre"]);

function fail(message) {
  throw new TypeError(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("canonical JSON contains a lone surrogate");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("canonical JSON contains a lone surrogate");
    }
  }
}

function canonicalize(value, activeObjects) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("canonical JSON accepts JSON values only");
  if (activeObjects.has(value)) fail("canonical JSON must not contain cycles");
  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail("canonical JSON arrays must not be sparse or extended");
      }
      return `[${value.map((item) => canonicalize(item, activeObjects)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("canonical JSON accepts plain objects only");
    }
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      fail("canonical JSON objects must not have hidden or symbol properties");
    }
    return `{${keys.map((key) => {
      assertWellFormedString(key);
      return `${JSON.stringify(key)}:${canonicalize(value[key], activeObjects)}`;
    }).join(",")}}`;
  } finally {
    activeObjects.delete(value);
  }
}

export function canonicalizeHttpCanaryReleasePayload(value) {
  return canonicalize(value, new WeakSet());
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function httpCanaryEvidenceTextSha256(value, label = "HTTP canary evidence") {
  if (typeof value !== "string" || value.length === 0) fail(`${label} text is required`);
  return sha256Bytes(value);
}

export function httpCanaryLoadEvidenceTextsSha256(value) {
  assertExactKeys(value, Object.keys(CANARY_LOAD_PROFILES), "canary load evidence texts");
  const hashes = Object.fromEntries(Object.keys(CANARY_LOAD_PROFILES).map((profile) => [
    profile,
    httpCanaryEvidenceTextSha256(value[profile], `${profile} load evidence`),
  ]));
  return sha256Bytes(canonicalizeHttpCanaryReleasePayload(hashes));
}

function parseJsonText(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} text is required`);
  try {
    const parsed = JSON.parse(value);
    assertObject(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    fail(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseIso(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be normalized ISO-8601`);
  }
  return Date.parse(value);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail(`${label} must be a sha256 digest`);
  }
}

function assertCandidateSha(value, label = "candidateSha") {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail(`${label} must be a full lower-case Git SHA`);
  }
}

function assertFreshWindow({ completedAt, expiresAt, validatedAt, label, maximumMs = oneDayMs }) {
  const completionTime = parseIso(completedAt, `${label}.completedAt`);
  const expiryTime = parseIso(expiresAt, `${label}.expiresAt`);
  if (expiryTime <= completionTime || expiryTime - completionTime > maximumMs) {
    fail(`${label} expiry must be after completion and no more than 24 hours later`);
  }
  if (completionTime > validatedAt || validatedAt > expiryTime) {
    fail(`${label} is expired or from the future`);
  }
  return { completionTime, expiryTime };
}

function assertTrustPolicy(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "policyId", "repository", "keys"],
    "HTTP canary trust policy",
  );
  if (value.schemaVersion !== "qrai-http-canary-trust-policy/v1") {
    fail("HTTP canary trust policy schemaVersion is unsupported");
  }
  if (typeof value.policyId !== "string" || !stableIdPattern.test(value.policyId)) {
    fail("HTTP canary trust policy policyId is invalid");
  }
  if (typeof value.repository !== "string" || !repositoryPattern.test(value.repository)) {
    fail("HTTP canary trust policy repository must be canonical owner/repository");
  }
  if (!Array.isArray(value.keys) || value.keys.length < requiredTrustRoles.length) {
    fail("HTTP canary trust policy must contain independent keys for every required role");
  }
  const keys = new Map();
  const keyMaterial = new Set();
  const activeRoles = new Set();
  for (const entry of value.keys) {
    assertExactKeys(
      entry,
      ["keyId", "algorithm", "role", "status", "publicKeyJwk"],
      "HTTP canary trusted key",
    );
    if (typeof entry.keyId !== "string" || !stableIdPattern.test(entry.keyId) || keys.has(entry.keyId)) {
      fail("HTTP canary trust policy contains an invalid or duplicate keyId");
    }
    if (entry.algorithm !== "Ed25519") fail(`trusted key ${entry.keyId} must use Ed25519`);
    if (!requiredTrustRoles.includes(entry.role)) fail(`trusted key ${entry.keyId} has an invalid role`);
    if (entry.status !== "active" && entry.status !== "revoked") {
      fail(`trusted key ${entry.keyId} has an invalid status`);
    }
    assertExactKeys(entry.publicKeyJwk, ["kty", "crv", "x"], "Ed25519 public JWK");
    const { kty, crv, x } = entry.publicKeyJwk;
    if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || !publicKeyPattern.test(x)) {
      fail(`trusted key ${entry.keyId} must contain a canonical Ed25519 public key`);
    }
    const decoded = Buffer.from(x, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== x) {
      fail(`trusted key ${entry.keyId} must contain a canonical Ed25519 public key`);
    }
    if (keyMaterial.has(x)) fail("HTTP canary trust policy reuses public key material across roles");
    let publicKey;
    try {
      publicKey = createPublicKey({ key: entry.publicKeyJwk, format: "jwk" });
    } catch {
      fail(`trusted key ${entry.keyId} is not a valid Ed25519 public key`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail(`trusted key ${entry.keyId} is not an Ed25519 public key`);
    }
    keys.set(entry.keyId, { ...entry, publicKey });
    keyMaterial.add(x);
    if (entry.status === "active") activeRoles.add(entry.role);
  }
  for (const role of requiredTrustRoles) {
    if (!activeRoles.has(role)) fail(`HTTP canary trust policy has no active ${role} key`);
  }
  return { policyId: value.policyId, repository: value.repository, keys };
}

function decodeSignature(value) {
  if (typeof value !== "string") fail("signatureBase64Url is required");
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    fail("signatureBase64Url must be a canonical Ed25519 signature");
  }
  return signature;
}

function verifySignedBundle(bundle, {
  bundleSchema,
  label,
  expectedRole,
  trust,
  validatedAt,
}) {
  assertExactKeys(bundle, ["schemaVersion", "payload", "signature"], label);
  if (bundle.schemaVersion !== bundleSchema) fail(`${label} schemaVersion is unsupported`);
  assertObject(bundle.payload, `${label} payload`);
  assertExactKeys(
    bundle.signature,
    ["keyId", "algorithm", "payloadSha256", "signatureBase64Url", "signedAt"],
    `${label} signature`,
  );
  const signer = trust.keys.get(bundle.signature.keyId);
  if (!signer) fail(`${label} signature key is not trusted`);
  if (signer.status !== "active") fail(`${label} signature key is not active`);
  if (signer.role !== expectedRole) fail(`${label} must be signed by the ${expectedRole} role`);
  if (bundle.signature.algorithm !== "Ed25519") fail(`${label} signature must use Ed25519`);
  const payloadBytes = Buffer.from(canonicalizeHttpCanaryReleasePayload(bundle.payload), "utf8");
  const payloadSha256 = sha256Bytes(payloadBytes);
  if (bundle.signature.payloadSha256 !== payloadSha256) {
    fail(`${label} payload sha256 does not match its canonical bytes`);
  }
  if (!verifySignature(null, payloadBytes, signer.publicKey, decodeSignature(bundle.signature.signatureBase64Url))) {
    fail(`${label} Ed25519 signature is invalid`);
  }
  const signedAt = parseIso(bundle.signature.signedAt, `${label}.signature.signedAt`);
  if (signedAt > validatedAt) fail(`${label} signature is from the future`);
  return {
    payload: structuredClone(bundle.payload),
    payloadSha256,
    keyId: signer.keyId,
    role: signer.role,
    signedAt,
    signedAtIso: bundle.signature.signedAt,
  };
}

function assertObservationAttestation(bundle, { trust, candidate, validatedAt }) {
  const verified = verifySignedBundle(bundle, {
    bundleSchema: "qrai-http-canary-observation-bundle/v1",
    label: "HTTP canary observation evidence",
    expectedRole: "monitoring-attestor",
    trust,
    validatedAt,
  });
  const payload = verified.payload;
  assertExactKeys(payload, [
    "schemaVersion",
    "candidateSha",
    "nodeImageId",
    "topologySha256",
    "source",
    "startedAt",
    "completedAt",
    "expiresAt",
    "metricQueriesSha256",
    "activeProbeResultsSha256",
    "observation",
  ], "HTTP canary observation payload");
  if (payload.schemaVersion !== "qrai-http-canary-observation/v1") {
    fail("HTTP canary observation payload schemaVersion is unsupported");
  }
  if (payload.candidateSha !== candidate.sourceSha) fail("observation candidateSha does not match candidate");
  if (payload.nodeImageId !== candidate.nodeImageId) fail("observation nodeImageId does not match candidate");
  if (payload.topologySha256 !== candidate.topologySha256) {
    fail("observation topologySha256 does not match candidate");
  }
  if (payload.source !== "prometheus-and-active-probes") {
    fail("observation source must be prometheus-and-active-probes");
  }
  assertDigest(payload.metricQueriesSha256, "observation metricQueriesSha256");
  assertDigest(payload.activeProbeResultsSha256, "observation activeProbeResultsSha256");
  const startedAt = parseIso(payload.startedAt, "observation.startedAt");
  const { completionTime, expiryTime } = assertFreshWindow({
    completedAt: payload.completedAt,
    expiresAt: payload.expiresAt,
    validatedAt,
    label: "HTTP canary observation evidence",
  });
  if (completionTime - startedAt < minimumObservationMs) {
    fail("HTTP canary observation must span at least 15 minutes");
  }
  const stopSignals = evaluateHttpCanaryObservation(payload.observation);
  if (stopSignals.length !== 0) fail("promotion observation contains an automatic stop signal");
  if (verified.signedAt < completionTime || verified.signedAt > expiryTime) {
    fail("observation signature must be created after observation and before expiry");
  }
  return { ...verified, payload, startedAt, completionTime, expiryTime };
}

function assertRemoteCiAttestation(bundle, { trust, candidateSha, validatedAt }) {
  const verified = verifySignedBundle(bundle, {
    bundleSchema: "qrai-http-canary-remote-ci-bundle/v1",
    label: "HTTP canary remote CI evidence",
    expectedRole: "ci-attestor",
    trust,
    validatedAt,
  });
  const payload = verified.payload;
  assertExactKeys(payload, [
    "schemaVersion",
    "candidateSha",
    "repository",
    "runId",
    "runAttempt",
    "runUrl",
    "event",
    "completedAt",
    "expiresAt",
    "checks",
  ], "HTTP canary remote CI payload");
  if (payload.schemaVersion !== "qrai-http-canary-remote-ci/v1") {
    fail("HTTP canary remote CI payload schemaVersion is unsupported");
  }
  if (payload.candidateSha !== candidateSha) fail("remote CI candidateSha does not match candidate");
  if (payload.repository !== trust.repository) fail("remote CI repository does not match trust policy");
  if (typeof payload.runId !== "string" || !/^[1-9][0-9]{0,19}$/.test(payload.runId)) {
    fail("remote CI runId must be a positive decimal identifier");
  }
  if (!Number.isSafeInteger(payload.runAttempt) || payload.runAttempt < 1) {
    fail("remote CI runAttempt must be a positive whole number");
  }
  const expectedUrl = `https://github.com/${payload.repository}/actions/runs/${payload.runId}`;
  if (payload.runUrl !== expectedUrl) fail("remote CI runUrl does not match repository and runId");
  if (payload.event !== "push" && payload.event !== "workflow_dispatch") {
    fail("remote CI event must be push or workflow_dispatch");
  }
  const { completionTime, expiryTime } = assertFreshWindow({
    completedAt: payload.completedAt,
    expiresAt: payload.expiresAt,
    validatedAt,
    label: "HTTP canary remote CI evidence",
  });
  if (!Array.isArray(payload.checks)) fail("remote CI checks must be an array");
  const names = payload.checks.map((check) => {
    assertExactKeys(check, ["name", "conclusion"], "remote CI check");
    if (check.conclusion !== "success") fail(`remote CI check ${check.name} did not succeed`);
    return check.name;
  });
  if (!isDeepStrictEqual(names, HTTP_CANARY_REQUIRED_REMOTE_CHECKS)) {
    fail("remote CI evidence must contain the exact ordered required check inventory");
  }
  if (verified.signedAt < completionTime || verified.signedAt > expiryTime) {
    fail("remote CI signature must be created after checks completed and before expiry");
  }
  return { ...verified, payload, completionTime, expiryTime };
}

function assertControllerFreshness(value, validatedAt, label) {
  const completionTime = parseIso(value.completedAt, `${label}.completedAt`);
  if (completionTime > validatedAt || validatedAt - completionTime > oneDayMs) {
    fail(`${label} is expired or from the future`);
  }
  return completionTime;
}

function assertSameSelection(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} selection does not match candidate evidence`);
}

function assertApproval(bundle, {
  role,
  trust,
  expected,
  earliestApprovalTime,
  validatedAt,
}) {
  const verified = verifySignedBundle(bundle, {
    bundleSchema: "qrai-http-canary-approval-bundle/v1",
    label: `${role} approval evidence`,
    expectedRole: role,
    trust,
    validatedAt,
  });
  const payload = verified.payload;
  assertExactKeys(payload, [
    "schemaVersion",
    "role",
    "decision",
    "candidateSha",
    "candidateEvidenceSha256",
    "loadEvidenceSha256",
    "observationEvidencePayloadSha256",
    "healthyControllerEvidenceSha256",
    "rollbackControllerEvidenceSha256",
    "remoteCiEvidencePayloadSha256",
    "approvedAt",
    "expiresAt",
  ], `${role} approval payload`);
  if (payload.schemaVersion !== "qrai-http-canary-approval/v1") {
    fail(`${role} approval payload schemaVersion is unsupported`);
  }
  if (payload.role !== role || payload.decision !== "approve") {
    fail(`${role} approval must carry its exact role and approve decision`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (payload[key] !== expectedValue) fail(`${role} approval ${key} does not match release evidence`);
  }
  const approvedAt = parseIso(payload.approvedAt, `${role} approval approvedAt`);
  const expiresAt = parseIso(payload.expiresAt, `${role} approval expiresAt`);
  if (approvedAt < earliestApprovalTime) fail(`${role} approval predates the evidence it approves`);
  if (expiresAt <= approvedAt || expiresAt - approvedAt > oneDayMs) {
    fail(`${role} approval must expire no more than 24 hours after approval`);
  }
  if (approvedAt > validatedAt || validatedAt > expiresAt) fail(`${role} approval is expired or future`);
  if (verified.signedAt < approvedAt || verified.signedAt > expiresAt) {
    fail(`${role} signature must be created after approval and before expiry`);
  }
  return { ...verified, payload, approvedAt, expiresAt };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertHttpCanaryReleaseEvidenceDocuments(documents, options) {
  if (!documents?.candidateEvidenceText) fail("candidate image evidence text is required");
  assertExactKeys(documents, [
    "candidateEvidenceText",
    "loadEvidenceTexts",
    "observationEvidenceText",
    "healthyControllerEvidenceText",
    "rollbackControllerEvidenceText",
    "remoteCiEvidenceText",
    "approvalEvidenceTexts",
    "trustPolicy",
  ], "HTTP canary release evidence documents");
  assertExactKeys(options, ["validatedAt", "expectedCandidateSha"], "HTTP canary release options");
  assertCandidateSha(options.expectedCandidateSha, "expectedCandidateSha");
  const validatedAt = parseIso(options.validatedAt, "validatedAt");
  const trust = assertTrustPolicy(documents.trustPolicy);

  const candidateValue = parseJsonText(documents.candidateEvidenceText, "candidate image evidence");
  const candidate = assertHttpCanaryImageEvidenceForPromotion(candidateValue, {
    validatedAt: options.validatedAt,
  });
  if (candidate.sourceSha !== options.expectedCandidateSha) {
    fail("candidate image evidence does not match the expected candidate SHA");
  }
  const nodeImage = candidate.images.find(({ service }) => service === "node-api");
  if (!nodeImage) fail("candidate image evidence is missing node-api");
  const candidateIdentity = {
    sourceSha: candidate.sourceSha,
    nodeImageId: nodeImage.imageId,
    topologySha256: candidate.topology.renderedSha256,
  };
  const candidateEvidenceSha256 = httpCanaryEvidenceTextSha256(
    documents.candidateEvidenceText,
    "candidate image evidence",
  );

  assertExactKeys(
    documents.loadEvidenceTexts,
    Object.keys(CANARY_LOAD_PROFILES),
    "canary load evidence texts",
  );
  const loadValues = Object.fromEntries(Object.entries(documents.loadEvidenceTexts).map(
    ([profile, text]) => [profile, parseJsonText(text, `${profile} load evidence`)],
  ));
  const loads = assertCanaryLoadEvidenceSetForPromotion(loadValues, candidateIdentity, {
    validatedAt: options.validatedAt,
  });
  const loadEvidenceSha256 = httpCanaryLoadEvidenceTextsSha256(documents.loadEvidenceTexts);

  const observationBundle = parseJsonText(
    documents.observationEvidenceText,
    "HTTP canary observation evidence",
  );
  const observation = assertObservationAttestation(observationBundle, {
    trust,
    candidate: candidateIdentity,
    validatedAt,
  });

  const healthy = assertHttpCanaryControllerEvidence(parseJsonText(
    documents.healthyControllerEvidenceText,
    "healthy controller evidence",
  ));
  const rollback = assertHttpCanaryControllerEvidence(parseJsonText(
    documents.rollbackControllerEvidenceText,
    "rollback controller evidence",
  ));
  if (healthy.status !== "awaiting-human-promotion" || healthy.runClass !== "observation") {
    fail("healthy controller evidence must await human promotion from an observation run");
  }
  if (rollback.status !== "rollback-complete" || rollback.runClass !== "deliberate-drill") {
    fail("rollback controller evidence must be a completed deliberate drill");
  }
  for (const [label, value] of [["healthy controller", healthy], ["rollback controller", rollback]]) {
    assertSameSelection(value.selection, candidate.selection, label);
    if (value.candidateEvidenceSha256 !== candidateEvidenceSha256) {
      fail(`${label} candidate evidence hash does not match the supplied artifact`);
    }
    if (value.loadEvidenceSha256 !== loadEvidenceSha256) {
      fail(`${label} load evidence hash does not match the supplied artifact set`);
    }
  }
  if (!isDeepStrictEqual(healthy.observation, observation.payload.observation)) {
    fail("healthy controller observation does not match signed monitoring evidence");
  }
  const healthyCompletion = assertControllerFreshness(healthy, validatedAt, "healthy controller evidence");
  const rollbackCompletion = assertControllerFreshness(rollback, validatedAt, "rollback controller evidence");
  const latestLoadCompletion = Math.max(...Object.values(loads).map(({ completedAt }) => Date.parse(completedAt)));
  if (latestLoadCompletion > observation.startedAt) {
    fail("signed observation started before all candidate load profiles completed");
  }
  if (observation.completionTime > Date.parse(healthy.startedAt)) {
    fail("healthy controller ran before the signed observation window completed");
  }
  if (healthyCompletion > Date.parse(rollback.startedAt)) {
    fail("deliberate rollback drill ran before the healthy observation decision completed");
  }

  const remoteCiBundle = parseJsonText(documents.remoteCiEvidenceText, "HTTP canary remote CI evidence");
  const remoteCi = assertRemoteCiAttestation(remoteCiBundle, {
    trust,
    candidateSha: candidate.sourceSha,
    validatedAt,
  });

  const healthyControllerEvidenceSha256 = httpCanaryEvidenceTextSha256(
    documents.healthyControllerEvidenceText,
    "healthy controller evidence",
  );
  const rollbackControllerEvidenceSha256 = httpCanaryEvidenceTextSha256(
    documents.rollbackControllerEvidenceText,
    "rollback controller evidence",
  );
  const approvalExpected = {
    candidateSha: candidate.sourceSha,
    candidateEvidenceSha256,
    loadEvidenceSha256,
    observationEvidencePayloadSha256: observation.payloadSha256,
    healthyControllerEvidenceSha256,
    rollbackControllerEvidenceSha256,
    remoteCiEvidencePayloadSha256: remoteCi.payloadSha256,
  };
  assertExactKeys(documents.approvalEvidenceTexts, approvalRoles, "HTTP canary approval evidence texts");
  const earliestApprovalTime = Math.max(
    healthyCompletion,
    rollbackCompletion,
    observation.completionTime,
    remoteCi.completionTime,
  );
  const approvals = approvalRoles.map((role) => assertApproval(
    parseJsonText(documents.approvalEvidenceTexts[role], `${role} approval evidence`),
    { role, trust, expected: approvalExpected, earliestApprovalTime, validatedAt },
  ));
  if (new Set(approvals.map(({ keyId }) => keyId)).size !== approvals.length) {
    fail("owner, security, and SRE approvals must use independent trusted keys");
  }

  return deepFreeze({
    schemaVersion: "qrai-http-canary-release-evidence/v1",
    status: "ready-for-manual-promotion",
    candidateSha: candidate.sourceSha,
    previousSha: candidate.selection.previous.sourceSha,
    registryNamespace: candidate.selection.registryNamespace,
    validatedAt: options.validatedAt,
    trustPolicy: {
      policyId: trust.policyId,
      repository: trust.repository,
    },
    artifacts: {
      candidateEvidenceSha256,
      loadEvidenceSha256,
      observationEvidencePayloadSha256: observation.payloadSha256,
      healthyControllerEvidenceSha256,
      rollbackControllerEvidenceSha256,
      remoteCiEvidencePayloadSha256: remoteCi.payloadSha256,
    },
    remoteCi: {
      repository: remoteCi.payload.repository,
      runId: remoteCi.payload.runId,
      runAttempt: remoteCi.payload.runAttempt,
      runUrl: remoteCi.payload.runUrl,
      checks: [...HTTP_CANARY_REQUIRED_REMOTE_CHECKS],
      keyId: remoteCi.keyId,
    },
    monitoring: {
      source: observation.payload.source,
      startedAt: observation.payload.startedAt,
      completedAt: observation.payload.completedAt,
      keyId: observation.keyId,
    },
    approvals: approvals.map(({ role, keyId, payloadSha256, signedAtIso }) => ({
      role,
      keyId,
      payloadSha256,
      signedAt: signedAtIso,
    })),
  });
}

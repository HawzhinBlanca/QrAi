import { assertReleaseDeploymentSelection } from "./release-deployment.mjs";

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export const HTTP_CANARY_OBSERVATION_KEYS = Object.freeze([
  "nodeReady",
  "workerReady",
  "rustReady",
  "httpErrorRate",
  "httpP95Ms",
  "fallbackShare",
  "jobQueued",
  "jobRetry",
  "jobDead",
  "privacyFailures",
  "tenantIsolationFailures",
  "lostChunks",
  "feedbackLeaks",
]);

export const HTTP_CANARY_STOP_LIMITS = Object.freeze({
  httpErrorRate: 0.01,
  httpP95Ms: 1000,
  fallbackShare: 0.05,
  jobQueued: 100,
  jobRetry: 10,
  jobDead: 0,
  privacyFailures: 0,
  tenantIsolationFailures: 0,
  lostChunks: 0,
  feedbackLeaks: 0,
});

export function httpCanaryControllerCommandPlan({ projectName }) {
  if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
    throw new TypeError("projectName must be a lower-case Compose project name");
  }
  const compose = [
    "docker",
    "compose",
    "--project-name",
    projectName,
    "--file",
    "docker-compose.yml",
    "--file",
    "docker-compose.release.yml",
  ];
  return Object.freeze({
    reverseTraffic: Object.freeze([
      ...compose,
      "up",
      "-d",
      "--no-deps",
      "--pull",
      "never",
      "node-api",
      "realtime-gateway",
      "web",
    ]),
    deployPrevious: Object.freeze([
      ...compose,
      "up",
      "-d",
      "--no-deps",
      "--pull",
      "never",
      "platform-api",
      "node-api",
      "job-worker",
      "realtime-gateway",
      "asr-inference",
      "web",
    ]),
    verifyPrevious: Object.freeze([
      "node",
      "scripts/release-deployment.mjs",
      "verify",
      "--slot",
      "previous",
      "--scope",
      "application",
    ]),
  });
}

const signals = Object.freeze({
  nodeReady: "node-unready",
  workerReady: "worker-unready",
  rustReady: "rust-unready",
  httpErrorRate: "http-error-rate",
  httpP95Ms: "http-latency",
  fallbackShare: "fallback-share",
  jobQueued: "job-backlog",
  jobRetry: "job-retries",
  jobDead: "job-dead-letter",
  privacyFailures: "privacy-failure",
  tenantIsolationFailures: "tenant-isolation-failure",
  lostChunks: "lost-audio-chunk",
  feedbackLeaks: "learner-feedback-leak",
});

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function parseIso(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be normalized ISO-8601`);
  }
  return Date.parse(value);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function validateObservation(value) {
  assertObject(value, "HTTP canary observation");
  assertExactKeys(value, HTTP_CANARY_OBSERVATION_KEYS, "HTTP canary observation");
  for (const key of ["nodeReady", "workerReady", "rustReady"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`${key} must be boolean`);
  }
  for (const key of HTTP_CANARY_OBSERVATION_KEYS.slice(3)) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new TypeError(`${key} must be a finite non-negative number`);
    }
  }
  for (const key of ["httpErrorRate", "fallbackShare"]) {
    if (value[key] > 1) throw new TypeError(`${key} must not exceed 1`);
  }
  for (const key of [
    "jobQueued",
    "jobRetry",
    "jobDead",
    "privacyFailures",
    "tenantIsolationFailures",
    "lostChunks",
    "feedbackLeaks",
  ]) {
    if (!Number.isSafeInteger(value[key])) throw new TypeError(`${key} must be a whole number`);
  }
  return { ...value };
}

export function evaluateHttpCanaryObservation(value) {
  const observation = validateObservation(value);
  const stopSignals = [];
  for (const key of ["nodeReady", "workerReady", "rustReady"]) {
    if (!observation[key]) stopSignals.push(signals[key]);
  }
  for (const key of Object.keys(HTTP_CANARY_STOP_LIMITS)) {
    if (observation[key] > HTTP_CANARY_STOP_LIMITS[key]) stopSignals.push(signals[key]);
  }
  return stopSignals;
}

function validateOperationResult(value, label) {
  assertObject(value, label);
  assertExactKeys(value, ["commandSha256", "outputSha256"], label);
  assertDigest(value.commandSha256, `${label}.commandSha256`);
  assertDigest(value.outputSha256, `${label}.outputSha256`);
  return { ...value };
}

function validateVerification(value) {
  assertObject(value, "rollback verification");
  assertExactKeys(
    value,
    [
      "commandSha256",
      "outputSha256",
      "applicationImagesVerified",
      "storedEffects",
      "duplicateEffects",
      "privacyCleanup",
    ],
    "rollback verification",
  );
  assertDigest(value.commandSha256, "rollback verification.commandSha256");
  assertDigest(value.outputSha256, "rollback verification.outputSha256");
  if (value.applicationImagesVerified !== 6) {
    throw new TypeError("rollback verification must prove six previous application images");
  }
  if (value.storedEffects !== 1) {
    throw new TypeError("rollback verification must prove exactly one stored effect");
  }
  if (value.duplicateEffects !== 0) {
    throw new TypeError("rollback verification must prove zero duplicate effects");
  }
  if (value.privacyCleanup !== "passed") {
    throw new TypeError("rollback verification must prove privacy cleanup passed");
  }
  return { ...value };
}

function validateRunClass(runClass, stopSignals) {
  if (stopSignals.length === 0) {
    if (runClass !== "observation") {
      throw new TypeError("runClass must be observation when no stop signal exists");
    }
  } else if (runClass !== "deliberate-drill" && runClass !== "incident") {
    throw new TypeError("runClass must be deliberate-drill or incident when a stop signal exists");
  }
  return runClass;
}

function transition(state, at) {
  parseIso(at, `${state}.at`);
  return { state, at };
}

function baseEvidence({
  status,
  selection,
  sourceSha,
  runClass,
  candidateEvidenceSha256,
  loadEvidenceSha256,
  startedAt,
  completedAt,
  observation,
  stopSignals,
  transitions,
  rollback,
  failure,
}) {
  return {
    schemaVersion: "qrai-http-canary-controller-evidence/v1",
    status,
    sourceSha,
    runClass,
    candidateEvidenceSha256,
    loadEvidenceSha256,
    selection,
    startedAt,
    completedAt,
    observation,
    stopSignals,
    transitions,
    rollback,
    ...(failure ? { failure } : {}),
  };
}

export function assertHttpCanaryControllerEvidence(value) {
  assertObject(value, "HTTP canary controller evidence");
  const failed = value.status === "rollback-failed";
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "status",
      "sourceSha",
      "runClass",
      "candidateEvidenceSha256",
      "loadEvidenceSha256",
      "selection",
      "startedAt",
      "completedAt",
      "observation",
      "stopSignals",
      "transitions",
      "rollback",
      ...(failed ? ["failure"] : []),
    ],
    "HTTP canary controller evidence",
  );
  if (value.schemaVersion !== "qrai-http-canary-controller-evidence/v1") {
    throw new TypeError("HTTP canary controller evidence schemaVersion is unsupported");
  }
  if (!["awaiting-human-promotion", "rollback-complete", "rollback-failed"].includes(value.status)) {
    throw new TypeError("HTTP canary controller evidence status is unsupported");
  }
  const selection = assertReleaseDeploymentSelection(value.selection);
  if (!shaPattern.test(value.sourceSha) || value.sourceSha !== selection.candidate.sourceSha) {
    throw new TypeError("controller sourceSha must match the candidate selection");
  }
  assertDigest(value.candidateEvidenceSha256, "candidateEvidenceSha256");
  assertDigest(value.loadEvidenceSha256, "loadEvidenceSha256");
  const startedAt = parseIso(value.startedAt, "startedAt");
  const completedAt = parseIso(value.completedAt, "completedAt");
  if (completedAt < startedAt) throw new TypeError("completedAt must not precede startedAt");
  const observation = validateObservation(value.observation);
  const expectedSignals = evaluateHttpCanaryObservation(observation);
  const runClass = validateRunClass(value.runClass, expectedSignals);
  if (JSON.stringify(value.stopSignals) !== JSON.stringify(expectedSignals)) {
    throw new TypeError("stopSignals must exactly match the immutable stop policy");
  }
  if (!Array.isArray(value.transitions) || value.transitions.length < 2) {
    throw new TypeError("controller transitions must record the state sequence");
  }
  let priorTransitionAt = startedAt;
  const transitions = value.transitions.map((entry, index) => {
    assertObject(entry, "controller transition");
    assertExactKeys(entry, ["state", "at"], "controller transition");
    if (typeof entry.state !== "string" || entry.state.length === 0) {
      throw new TypeError("controller transition.state is required");
    }
    const at = parseIso(entry.at, `${entry.state}.at`);
    if (
      (index === 0 && at !== startedAt) ||
      at < priorTransitionAt ||
      at > completedAt
    ) {
      throw new TypeError("controller transition timestamps must be monotonic within the run window");
    }
    priorTransitionAt = at;
    return { state: entry.state, at: entry.at };
  });
  if (priorTransitionAt !== completedAt) {
    throw new TypeError("the final controller transition must close the run window");
  }
  const states = transitions.map(({ state }) => state);
  if (value.status === "awaiting-human-promotion") {
    if (expectedSignals.length !== 0) throw new TypeError("a stop signal cannot await promotion");
    if (JSON.stringify(states) !== JSON.stringify(["observing", "awaiting-human-promotion"])) {
      throw new TypeError("healthy controller transition sequence is invalid");
    }
    if (value.rollback !== null) throw new TypeError("healthy observation must not mutate rollback state");
  } else if (value.status === "rollback-complete") {
    if (expectedSignals.length === 0) throw new TypeError("rollback requires at least one stop signal");
    if (
      JSON.stringify(states) !== JSON.stringify([
        "observing",
        "stop-triggered",
        "traffic-reversed",
        "previous-deployed",
        "rollback-verified",
      ])
    ) {
      throw new TypeError("completed rollback transition sequence is invalid");
    }
    assertObject(value.rollback, "rollback evidence");
    assertExactKeys(value.rollback, ["reversal", "deployment", "verification"], "rollback evidence");
    validateOperationResult(value.rollback.reversal, "traffic reversal");
    validateOperationResult(value.rollback.deployment, "previous deployment");
    validateVerification(value.rollback.verification);
  } else {
    if (expectedSignals.length === 0) throw new TypeError("failed rollback requires a stop signal");
    const policies = {
      "traffic reversal failed": {
        states: ["observing", "stop-triggered", "rollback-failed"],
        rollbackKeys: [],
      },
      "previous deployment failed": {
        states: ["observing", "stop-triggered", "traffic-reversed", "rollback-failed"],
        rollbackKeys: ["reversal"],
      },
      "previous verification failed": {
        states: [
          "observing",
          "stop-triggered",
          "traffic-reversed",
          "previous-deployed",
          "rollback-failed",
        ],
        rollbackKeys: ["reversal", "deployment"],
      },
    };
    const policy = policies[value.failure];
    if (!policy) {
      throw new TypeError("failed rollback must carry a fixed failure reason");
    }
    if (JSON.stringify(states) !== JSON.stringify(policy.states)) {
      throw new TypeError("failed rollback transition sequence is invalid");
    }
    assertObject(value.rollback, "failed rollback evidence");
    assertExactKeys(value.rollback, policy.rollbackKeys, "failed rollback evidence");
    if (value.rollback.reversal) {
      validateOperationResult(value.rollback.reversal, "traffic reversal");
    }
    if (value.rollback.deployment) {
      validateOperationResult(value.rollback.deployment, "previous deployment");
    }
  }
  return {
    ...value,
    runClass,
    selection,
    observation,
    transitions,
  };
}

export class HttpCanaryControllerError extends Error {
  constructor(message, evidence, options = undefined) {
    super(message, options);
    this.name = "HttpCanaryControllerError";
    this.evidence = evidence;
  }
}

function assertOperations(operations) {
  assertObject(operations, "controller operations");
  for (const name of ["reverseTraffic", "deployPrevious", "verifyPrevious"]) {
    if (typeof operations[name] !== "function") {
      throw new TypeError(`controller operations.${name} must be a function`);
    }
  }
}

export async function runHttpCanaryController({
  selection: selectionValue,
  sourceSha,
  runClass,
  candidateEvidenceSha256,
  loadEvidenceSha256,
  observation: observationValue,
  operations,
  now = () => new Date().toISOString(),
}) {
  const selection = assertReleaseDeploymentSelection(selectionValue);
  if (sourceSha !== selection.candidate.sourceSha) {
    throw new TypeError("controller sourceSha must match the candidate selection");
  }
  assertDigest(candidateEvidenceSha256, "candidateEvidenceSha256");
  assertDigest(loadEvidenceSha256, "loadEvidenceSha256");
  assertOperations(operations);
  if (typeof now !== "function") throw new TypeError("controller now must be a function");
  const observation = validateObservation(observationValue);
  const stopSignals = evaluateHttpCanaryObservation(observation);
  validateRunClass(runClass, stopSignals);
  const startedAt = now();
  parseIso(startedAt, "controller start time");
  const transitions = [transition("observing", startedAt)];

  if (stopSignals.length === 0) {
    const completedAt = now();
    transitions.push(transition("awaiting-human-promotion", completedAt));
    return assertHttpCanaryControllerEvidence(baseEvidence({
      status: "awaiting-human-promotion",
      selection,
      sourceSha,
      runClass,
      candidateEvidenceSha256,
      loadEvidenceSha256,
      startedAt,
      completedAt,
      observation,
      stopSignals,
      transitions,
      rollback: null,
    }));
  }

  transitions.push(transition("stop-triggered", now()));
  const rollback = {};
  const failOperation = (fixedReason, cause) => {
    const completedAt = now();
    transitions.push(transition("rollback-failed", completedAt));
    const evidence = baseEvidence({
      status: "rollback-failed",
      selection,
      sourceSha,
      runClass,
      candidateEvidenceSha256,
      loadEvidenceSha256,
      startedAt,
      completedAt,
      observation,
      stopSignals,
      transitions,
      rollback,
      failure: fixedReason,
    });
    throw new HttpCanaryControllerError(fixedReason, evidence, { cause });
  };

  try {
    rollback.reversal = validateOperationResult(await operations.reverseTraffic(), "traffic reversal");
  } catch (error) {
    failOperation("traffic reversal failed", error);
  }
  transitions.push(transition("traffic-reversed", now()));
  try {
    rollback.deployment = validateOperationResult(await operations.deployPrevious(), "previous deployment");
  } catch (error) {
    failOperation("previous deployment failed", error);
  }
  transitions.push(transition("previous-deployed", now()));
  try {
    rollback.verification = validateVerification(await operations.verifyPrevious());
  } catch (error) {
    failOperation("previous verification failed", error);
  }
  const completedAt = now();
  transitions.push(transition("rollback-verified", completedAt));
  return assertHttpCanaryControllerEvidence(baseEvidence({
    status: "rollback-complete",
    selection,
    sourceSha,
    runClass,
    candidateEvidenceSha256,
    loadEvidenceSha256,
    startedAt,
    completedAt,
    observation,
    stopSignals,
    transitions,
    rollback,
  }));
}

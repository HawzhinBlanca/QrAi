import { isDeepStrictEqual } from "node:util";

import { composeImageEnvironment, assertReleaseDeploymentSelection } from "./release-deployment.mjs";
import { DEPLOYABLE_IMAGES } from "./deployable-images.mjs";
import { loadHttpCanaryRouteKeys } from "./http-canary-probe.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const allowedEnvironmentClasses = new Set(["ci", "staging-isolated"]);
const allowedActorClasses = new Set(["release-automation", "release-operator"]);

export const REQUIRED_HTTP_CANARY_IMAGE_STAGES = Object.freeze([
  "candidate-running-images",
  "retained-hostile-input",
  "effect-privacy-tenant",
  "audio-index",
  "rust-unavailable-routes",
  "rust-restored",
]);

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

function expectedServiceReferences(selection) {
  const environment = composeImageEnvironment(selection, "candidate");
  return Object.fromEntries(
    DEPLOYABLE_IMAGES.flatMap(({ key, composeServices }) =>
      composeServices.map((service) => [
        service,
        environment[`${key.toUpperCase().replaceAll("-", "_")}_IMAGE`],
      ]),
    ),
  );
}

function assertImages(images, selection) {
  if (!Array.isArray(images)) throw new TypeError("running images must be an array");
  const expected = expectedServiceReferences(selection);
  const expectedServices = Object.keys(expected);
  if (
    images.length !== expectedServices.length ||
    JSON.stringify(images.map(({ service }) => service).sort()) !==
      JSON.stringify([...expectedServices].sort())
  ) {
    throw new TypeError("running image evidence must contain exactly the seven release services");
  }
  const idsByReference = new Map();
  for (const image of images) {
    assertObject(image, "running image");
    assertExactKeys(image, ["service", "containerId", "reference", "imageId"], "running image");
    if (image.reference !== expected[image.service]) {
      throw new TypeError(`${image.service} running image reference does not match the candidate`);
    }
    if (typeof image.containerId !== "string" || image.containerId.length < 1) {
      throw new TypeError(`${image.service} containerId is required`);
    }
    if (typeof image.imageId !== "string" || !imageIdPattern.test(image.imageId)) {
      throw new TypeError(`${image.service} imageId must identify immutable image content`);
    }
    const priorId = idsByReference.get(image.reference);
    if (priorId && priorId !== image.imageId) {
      throw new TypeError("services sharing one selected reference must share one imageId");
    }
    idsByReference.set(image.reference, image.imageId);
  }
  return images.map((image) => ({ ...image }));
}

function assertTopology(topology) {
  assertObject(topology, "HTTP canary topology");
  assertExactKeys(
    topology,
    ["renderedSha256", "webTarget", "gatewayTarget", "nodeRouteMode", "rustUpstream"],
    "HTTP canary topology",
  );
  assertDigest(topology.renderedSha256, "topology.renderedSha256");
  for (const [key, expected] of Object.entries({
    webTarget: "node-api:8082",
    gatewayTarget: "http://node-api:8082",
    nodeRouteMode: "retained-canary",
    rustUpstream: "http://platform-api:8080",
  })) {
    if (topology[key] !== expected) {
      throw new TypeError(`topology.${key} must be ${expected}`);
    }
  }
  return { ...topology };
}

function assertRustUnavailableDetails(details) {
  assertObject(details, "rust-unavailable-routes stage details");
  assertExactKeys(
    details,
    [
      "rustRunning",
      "retainedAttempted",
      "retainedFallbacks",
      "transitionAttempted",
      "transitionDependencyFailures",
    ],
    "rust-unavailable-routes stage details",
  );
  if (details.rustRunning !== false) {
    throw new TypeError("rust-unavailable-routes rustRunning must be false");
  }
  for (const [key, expected] of Object.entries({
    retainedAttempted: 39,
    retainedFallbacks: 0,
    transitionAttempted: 4,
    transitionDependencyFailures: 4,
  })) {
    if (details[key] !== expected) {
      throw new TypeError(`rust-unavailable-routes ${key} must be ${expected}`);
    }
  }
  return { ...details };
}

function assertStages(stages, startedAt, completedAt) {
  if (
    !Array.isArray(stages) ||
    JSON.stringify(stages.map(({ name }) => name)) !==
      JSON.stringify(REQUIRED_HTTP_CANARY_IMAGE_STAGES)
  ) {
    throw new TypeError("HTTP canary proof stages must contain exactly the required ordered stages");
  }
  let priorStageEnd = startedAt;
  return stages.map((stage) => {
    assertObject(stage, "HTTP canary proof stage");
    const required = [
      "name",
      "status",
      "startedAt",
      "completedAt",
      "commandSha256",
      "outputSha256",
    ];
    if (stage.name === "rust-unavailable-routes") required.push("details");
    assertExactKeys(stage, required, `HTTP canary proof stage ${stage.name}`);
    if (stage.status !== "passed") {
      throw new TypeError(`HTTP canary proof stage ${stage.name} must have passed`);
    }
    const stageStart = parseIso(stage.startedAt, `${stage.name}.startedAt`);
    const stageEnd = parseIso(stage.completedAt, `${stage.name}.completedAt`);
    if (stageStart < startedAt || stageEnd < stageStart || stageEnd > completedAt) {
      throw new TypeError(`${stage.name} timestamps must fall within the proof window`);
    }
    if (stageStart < priorStageEnd) {
      throw new TypeError("HTTP canary proof stage order must be monotonic and non-overlapping");
    }
    priorStageEnd = stageEnd;
    assertDigest(stage.commandSha256, `${stage.name}.commandSha256`);
    assertDigest(stage.outputSha256, `${stage.name}.outputSha256`);
    return {
      ...stage,
      ...(stage.name === "rust-unavailable-routes"
        ? { details: assertRustUnavailableDetails(stage.details) }
        : {}),
    };
  });
}

export function createHttpCanaryImageEvidence(input) {
  assertObject(input, "HTTP canary image evidence input");
  assertExactKeys(
    input,
    [
      "sourceState",
      "selection",
      "environment",
      "actorClass",
      "evidenceClass",
      "executionMode",
      "startedAt",
      "completedAt",
      "expiresAt",
      "topology",
      "routeKeys",
      "images",
      "stages",
      "validatedAt",
    ],
    "HTTP canary image evidence input",
  );
  const selection = assertReleaseDeploymentSelection(input.selection);
  assertObject(input.sourceState, "sourceState");
  assertExactKeys(input.sourceState, ["headSha", "clean"], "sourceState");
  if (input.sourceState.clean !== true) throw new TypeError("source tree must be clean");
  if (input.sourceState.headSha !== selection.candidate.sourceSha) {
    throw new TypeError("source SHA must match the selected candidate SHA");
  }
  if (input.executionMode !== "immutable-compose-images") {
    throw new TypeError("executionMode must use immutable Compose images");
  }
  if (input.evidenceClass !== "live-candidate") {
    throw new TypeError("evidenceClass must identify a live candidate, never a fixture");
  }
  assertObject(input.environment, "environment");
  assertExactKeys(input.environment, ["class", "provider"], "environment");
  if (!allowedEnvironmentClasses.has(input.environment.class)) {
    throw new TypeError("environment.class must be ci or staging-isolated");
  }
  if (typeof input.environment.provider !== "string" || input.environment.provider.length === 0) {
    throw new TypeError("environment.provider is required");
  }
  if (!allowedActorClasses.has(input.actorClass)) {
    throw new TypeError("actorClass must be release-automation or release-operator");
  }

  const startedAt = parseIso(input.startedAt, "startedAt");
  const completedAt = parseIso(input.completedAt, "completedAt");
  const expiresAt = parseIso(input.expiresAt, "expiresAt");
  const validatedAt = parseIso(input.validatedAt, "validatedAt");
  if (completedAt < startedAt) throw new TypeError("completedAt must not precede startedAt");
  if (Date.parse(selection.createdAt) > startedAt) {
    throw new TypeError("release selection must exist before the candidate proof starts");
  }
  if (expiresAt <= completedAt || expiresAt - completedAt > 24 * 60 * 60 * 1_000) {
    throw new TypeError("expiresAt must be after completion and no more than 24 hours later");
  }
  if (validatedAt < completedAt) throw new TypeError("HTTP canary image evidence completion is in the future");
  if (validatedAt > expiresAt) throw new TypeError("HTTP canary image evidence is expired");

  const expectedRoutes = loadHttpCanaryRouteKeys();
  if (JSON.stringify(input.routeKeys) !== JSON.stringify(expectedRoutes)) {
    throw new TypeError("routeKeys must equal the exact retained canary route inventory");
  }
  const topology = assertTopology(input.topology);
  const images = assertImages(input.images, selection);
  const stages = assertStages(input.stages, startedAt, completedAt);

  return {
    schemaVersion: "qrai-http-canary-image-evidence/v1",
    status: "passed",
    sourceSha: selection.candidate.sourceSha,
    sourceState: { ...input.sourceState },
    selection,
    environment: { ...input.environment },
    actorClass: input.actorClass,
    evidenceClass: input.evidenceClass,
    executionMode: input.executionMode,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    expiresAt: input.expiresAt,
    topology,
    routeKeys: [...input.routeKeys],
    images,
    stages,
  };
}

export function assertHttpCanaryImageEvidenceForPromotion(value, { validatedAt }) {
  assertObject(value, "HTTP canary image evidence");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "status",
      "sourceSha",
      "sourceState",
      "selection",
      "environment",
      "actorClass",
      "evidenceClass",
      "executionMode",
      "startedAt",
      "completedAt",
      "expiresAt",
      "topology",
      "routeKeys",
      "images",
      "stages",
    ],
    "HTTP canary image evidence",
  );
  if (value.schemaVersion !== "qrai-http-canary-image-evidence/v1" || value.status !== "passed") {
    throw new TypeError("HTTP canary image evidence must be a passed supported artifact");
  }
  const reconstructed = createHttpCanaryImageEvidence({
    sourceState: value.sourceState,
    selection: value.selection,
    environment: value.environment,
    actorClass: value.actorClass,
    evidenceClass: value.evidenceClass,
    executionMode: value.executionMode,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    expiresAt: value.expiresAt,
    topology: value.topology,
    routeKeys: value.routeKeys,
    images: value.images,
    stages: value.stages,
    validatedAt,
  });
  if (!isDeepStrictEqual(reconstructed, value)) {
    throw new TypeError("HTTP canary image evidence identity or policy was altered");
  }
  return reconstructed;
}

export function httpCanaryImageCommandPlan({ projectName }) {
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
    "--file",
    "docker-compose.canary.yml",
  ];
  return Object.freeze([
    [...compose, "config", "--format", "json"],
    ["node", "scripts/release-deployment.mjs", "verify", "--slot", "candidate"],
    ["node", "scripts/http-canary-image.mjs", "probe", "retained-hostile-input"],
    ["node", "scripts/smoke-api.mjs"],
    ["node", "scripts/smoke-gateway.mjs"],
    [...compose, "stop", "platform-api"],
    ["node", "scripts/http-canary-image.mjs", "probe", "rust-unavailable-routes"],
    [...compose, "up", "-d", "--no-deps", "platform-api"],
  ]);
}

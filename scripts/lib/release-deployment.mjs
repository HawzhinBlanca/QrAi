import {
  DEPLOYABLE_IMAGES,
  parseImageDigestDocument,
  releaseReference,
  releaseRepository,
  releaseTag,
} from "./deployable-images.mjs";

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export const RELEASE_APPLICATION_SERVICES = Object.freeze(
  DEPLOYABLE_IMAGES.flatMap(({ composeServices }) => composeServices)
    .filter((service) => service !== "migrations"),
);

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

function assertManifest(manifest, label, namespace) {
  assertObject(manifest, label);
  assertExactKeys(manifest, ["sourceSha", "imageDigests"], label);
  releaseTag("web", manifest.sourceSha, namespace);
  const imageDigests = parseImageDigestDocument(JSON.stringify(manifest.imageDigests));
  return { sourceSha: manifest.sourceSha, imageDigests };
}

function canonicalNamespace(namespace) {
  return releaseRepository("web", namespace).split("/")[1];
}

function composeVariable(key) {
  return `${key.toUpperCase().replaceAll("-", "_")}_IMAGE`;
}

export function assertReleaseDeploymentSelection(value) {
  assertObject(value, "release deployment selection");
  assertExactKeys(
    value,
    ["schemaVersion", "createdAt", "registryNamespace", "candidate", "previous"],
    "release deployment selection",
  );
  if (value.schemaVersion !== "qrai-release-deployment/v1") {
    throw new TypeError("release deployment selection schemaVersion is unsupported");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new TypeError("release deployment selection createdAt must be normalized ISO-8601");
  }
  const registryNamespace = canonicalNamespace(value.registryNamespace);
  if (registryNamespace !== value.registryNamespace) {
    throw new TypeError("release deployment selection registryNamespace must be canonical lower-case");
  }
  const candidate = assertManifest(value.candidate, "candidate", registryNamespace);
  const previous = assertManifest(value.previous, "previous", registryNamespace);
  if (candidate.sourceSha === previous.sourceSha) {
    throw new TypeError("candidate and previous source SHAs must differ");
  }
  return {
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    registryNamespace,
    candidate,
    previous,
  };
}

export function createReleaseDeploymentSelection({
  candidateSha,
  candidateImageDigests,
  previousSha,
  previousImageDigests,
  namespace,
  createdAt = new Date().toISOString(),
}) {
  return assertReleaseDeploymentSelection({
    schemaVersion: "qrai-release-deployment/v1",
    createdAt,
    registryNamespace: canonicalNamespace(namespace),
    candidate: { sourceSha: candidateSha, imageDigests: candidateImageDigests },
    previous: { sourceSha: previousSha, imageDigests: previousImageDigests },
  });
}

export function composeImageEnvironment(selectionValue, slot) {
  const selection = assertReleaseDeploymentSelection(selectionValue);
  if (slot !== "candidate" && slot !== "previous") {
    throw new TypeError("release deployment slot must be candidate or previous");
  }
  return Object.fromEntries(
    DEPLOYABLE_IMAGES.map(({ key }) => [
      composeVariable(key),
      releaseReference(key, selection[slot].imageDigests[key], selection.registryNamespace),
    ]),
  );
}

function expectedServiceReferences(selection, slot, services = null) {
  const environment = composeImageEnvironment(selection, slot);
  const references = Object.fromEntries(
    DEPLOYABLE_IMAGES.flatMap(({ key, composeServices }) =>
      composeServices.map((service) => [service, environment[composeVariable(key)]]),
    ),
  );
  if (services === null) return references;
  return Object.fromEntries(services.map((service) => [service, references[service]]));
}

function verifyRunningImages({ selection, slot, observations, services = null }) {
  assertObject(observations, "running image observations");
  const expected = expectedServiceReferences(selection, slot, services);
  const evidence = [];

  for (const [service, reference] of Object.entries(expected)) {
    const observation = observations[service];
    if (!observation) {
      throw new TypeError(`missing running image observation for ${service}`);
    }
    const completedMigration =
      service === "migrations" && observation.completed === true && observation.exitCode === 0;
    if (observation.running !== true && !completedMigration) {
      throw new TypeError(`${service} is not running`);
    }
    if (observation.configuredImage !== reference) {
      throw new TypeError(`${service} configured image does not match ${reference}`);
    }
    if (
      typeof observation.imageId !== "string" ||
      !imageIdPattern.test(observation.imageId) ||
      observation.localImageId !== observation.imageId
    ) {
      throw new TypeError(`${service} image content does not match the selected reference`);
    }
    if (!Array.isArray(observation.repoDigests) || !observation.repoDigests.includes(reference)) {
      throw new TypeError(`${service} local image does not carry the selected repository digest`);
    }
    if (typeof observation.containerId !== "string" || observation.containerId.length === 0) {
      throw new TypeError(`${service} containerId is required`);
    }
    evidence.push({
      service,
      containerId: observation.containerId,
      reference,
      imageId: observation.imageId,
    });
  }

  return evidence;
}

export function verifyRunningReleaseImages(input) {
  return verifyRunningImages(input);
}

export function verifyRunningReleaseApplicationImages(input) {
  return verifyRunningImages({ ...input, services: RELEASE_APPLICATION_SERVICES });
}

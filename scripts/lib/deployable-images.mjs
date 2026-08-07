const fullGitShaPattern = /^[a-f0-9]{40}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const registryNamespacePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export const DEPLOYABLE_IMAGES = [
  {
    key: "platform-api",
    composeServices: ["platform-api"],
    context: ".",
    dockerfile: "services/platform-api/Dockerfile",
  },
  {
    key: "node-backend",
    composeServices: ["node-api", "job-worker"],
    context: ".",
    dockerfile: "server/Dockerfile",
  },
  {
    key: "migration-runner",
    composeServices: ["migrations"],
    context: ".",
    dockerfile: "server/migrations.Dockerfile",
  },
  {
    key: "realtime-gateway",
    composeServices: ["realtime-gateway"],
    context: ".",
    dockerfile: "services/realtime-gateway/Dockerfile",
  },
  {
    key: "asr-inference",
    composeServices: ["asr-inference"],
    context: ".",
    dockerfile: "services/asr-inference/Dockerfile",
  },
  {
    key: "web",
    composeServices: ["web"],
    context: ".",
    dockerfile: "apps/web/Dockerfile",
  },
];

export const DEPLOYABLE_IMAGE_KEYS = DEPLOYABLE_IMAGES.map(({ key }) => key);

const deployableImageKeys = new Set(DEPLOYABLE_IMAGE_KEYS);

function assertDeployableImageKey(key) {
  if (!deployableImageKeys.has(key)) {
    throw new TypeError(`unknown deployable image: ${JSON.stringify(key)}`);
  }
}

function canonicalRegistryNamespace(namespace) {
  if (typeof namespace !== "string") {
    throw new TypeError("registry namespace must be a string");
  }
  const canonical = namespace.toLowerCase();
  if (!registryNamespacePattern.test(canonical)) {
    throw new TypeError(`invalid registry namespace: ${JSON.stringify(namespace)}`);
  }
  return canonical;
}

export function releaseRepository(key, namespace) {
  assertDeployableImageKey(key);
  return `ghcr.io/${canonicalRegistryNamespace(namespace)}/qrai-${key}`;
}

export function releaseTag(key, gitSha, namespace) {
  if (typeof gitSha !== "string" || !fullGitShaPattern.test(gitSha)) {
    throw new TypeError(`expected a full lowercase git sha, got ${JSON.stringify(gitSha)}`);
  }
  return `${releaseRepository(key, namespace)}:${gitSha}`;
}

export function releaseReference(key, digest, namespace) {
  if (typeof digest !== "string" || !imageDigestPattern.test(digest)) {
    throw new TypeError(`expected a sha256 image digest, got ${JSON.stringify(digest)}`);
  }
  return `${releaseRepository(key, namespace)}@${digest}`;
}

export function parseImageDigestDocument(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new TypeError("image digest document must be valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("image digest document must be a JSON object");
  }

  for (const key of Object.keys(document)) {
    if (!deployableImageKeys.has(key)) {
      throw new TypeError(`unexpected image digest key: ${key}`);
    }
  }
  for (const key of DEPLOYABLE_IMAGE_KEYS) {
    if (typeof document[key] !== "string" || !imageDigestPattern.test(document[key])) {
      throw new TypeError(`imageDigests.${key} must be an immutable sha256 digest`);
    }
  }

  return document;
}

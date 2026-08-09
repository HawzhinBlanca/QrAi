import { createHash } from "node:crypto";

import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./release-deployment.mjs";

const sourceShaPattern = /^[a-f0-9]{40}$/;
const expectedOwnerPattern = /^\d{12}$/;
const storageServices = Object.freeze(["node-api", "job-worker", "node-realtime"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function service(rendered, name) {
  const value = rendered.services?.[name];
  assertObject(value, `rendered Compose service ${name}`);
  return value;
}

function assertSelectedImage(rendered, serviceName, expectedImage) {
  const value = service(rendered, serviceName);
  if (value.image !== expectedImage) {
    throw new TypeError(`${serviceName} must use the selected immutable candidate image`);
  }
  if (value.build !== undefined && value.build !== null) {
    throw new TypeError(`${serviceName} must not retain a source build in release proof mode`);
  }
  return value;
}

function publishedPort(value) {
  return typeof value === "number" ? value : Number(value);
}

function assertNodePort(nodeRealtime, nodePort) {
  if (!Array.isArray(nodeRealtime.ports) || nodeRealtime.ports.length !== 1) {
    throw new TypeError("Node realtime proof must publish exactly one port");
  }
  const [port] = nodeRealtime.ports;
  assertObject(port, "Node realtime proof port");
  if (
    port.host_ip !== "127.0.0.1" ||
    publishedPort(port.published) !== nodePort ||
    Number(port.target) !== 8081 ||
    port.protocol !== "tcp"
  ) {
    throw new TypeError("Node realtime proof port must be the selected loopback mapped to 8081/tcp");
  }
}

function assertRustPort(gateway) {
  if (!Array.isArray(gateway.ports) || gateway.ports.length !== 1) {
    throw new TypeError("Rust gateway must retain exactly one public port");
  }
  const [port] = gateway.ports;
  assertObject(port, "Rust realtime public port");
  const host = port.host_ip ?? "0.0.0.0";
  if (
    publishedPort(port.published) !== 8081 ||
    Number(port.target) !== 8081 ||
    port.protocol !== "tcp" ||
    !new Set(["0.0.0.0", "::"]).has(host)
  ) {
    throw new TypeError("Rust must remain the public realtime owner on port 8081");
  }
}

function nonblank(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function storageConfiguration(rendered) {
  let identity = null;
  let encryption = null;
  for (const serviceName of storageServices) {
    const environment = service(rendered, serviceName).environment;
    assertObject(environment, `${serviceName} environment`);
    if (
      environment.AUDIO_STORAGE_DRIVER !== "s3" ||
      environment.AUDIO_STORAGE_FILESYSTEM_ACKNOWLEDGED_DEV_ONLY !== "0"
    ) {
      throw new TypeError(`${serviceName} must use production S3 with filesystem fallback disabled`);
    }
    const bucket = nonblank(environment.AUDIO_STORAGE_S3_BUCKET, `${serviceName} S3 bucket`);
    const region = nonblank(environment.AUDIO_STORAGE_S3_REGION, `${serviceName} S3 region`);
    const owner = nonblank(
      environment.AUDIO_STORAGE_S3_EXPECTED_OWNER,
      `${serviceName} expected owner`,
    );
    if (!expectedOwnerPattern.test(owner)) {
      throw new TypeError(`${serviceName} expected owner must be a 12-digit AWS account ID`);
    }
    const selectedEncryption = environment.AUDIO_STORAGE_S3_ENCRYPTION || "AES256";
    if (!new Set(["AES256", "aws:kms"]).has(selectedEncryption)) {
      throw new TypeError(`${serviceName} proof encryption must be AES256 or aws:kms`);
    }
    if (selectedEncryption === "aws:kms") {
      nonblank(environment.AUDIO_STORAGE_S3_KMS_KEY_ID, `${serviceName} S3 KMS key`);
    }
    const endpoint = environment.AUDIO_STORAGE_S3_ENDPOINT?.trim() || null;
    if (
      endpoint &&
      (!endpoint.startsWith("https://") || /(?:localhost|127\.0\.0\.1|minio|\.local)(?:[:/]|$)/i.test(endpoint))
    ) {
      throw new TypeError(`${serviceName} S3 endpoint must be a non-loopback HTTPS production endpoint`);
    }
    const currentIdentity = canonicalJson({ bucket, region, owner, selectedEncryption, endpoint });
    if (identity !== null && currentIdentity !== identity) {
      throw new TypeError("all Node roles must use the same production S3 identity");
    }
    identity = currentIdentity;
    encryption = selectedEncryption;
  }
  return {
    driver: "s3",
    requiredBucketClass: "production-private",
    encryption,
    expectedOwnerConfigured: true,
    filesystemFallback: false,
  };
}

export function parseRealtimeProofPort(value) {
  if (typeof value !== "string" || !/^[0-9]{4,5}$/.test(value)) {
    throw new TypeError("realtime proof port must be a decimal port number");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535 || port === 8081) {
    throw new TypeError("realtime proof port must be 1024..65535 and must not be Rust port 8081");
  }
  return port;
}

export function validateRealtimeProofRenderedTopology({ rendered, selection, nodePort }) {
  assertObject(rendered, "rendered Compose topology");
  if (!Number.isSafeInteger(nodePort) || nodePort < 1024 || nodePort > 65_535 || nodePort === 8081) {
    throw new TypeError("Node realtime proof port is invalid");
  }
  const selected = assertReleaseDeploymentSelection(selection);
  const imageEnvironment = composeImageEnvironment(selected, "candidate");
  const nodeApi = assertSelectedImage(rendered, "node-api", imageEnvironment.NODE_BACKEND_IMAGE);
  const worker = assertSelectedImage(rendered, "job-worker", imageEnvironment.NODE_BACKEND_IMAGE);
  const nodeRealtime = assertSelectedImage(
    rendered,
    "node-realtime",
    imageEnvironment.NODE_BACKEND_IMAGE,
  );
  const gateway = assertSelectedImage(
    rendered,
    "realtime-gateway",
    imageEnvironment.REALTIME_GATEWAY_IMAGE,
  );
  void nodeApi;
  void worker;
  assertNodePort(nodeRealtime, nodePort);
  assertRustPort(gateway);

  const web = service(rendered, "web");
  if (web.depends_on?.["node-realtime"] !== undefined) {
    throw new TypeError("Web must not target the Node realtime proof endpoint");
  }
  if (!web.depends_on?.["realtime-gateway"]) {
    throw new TypeError("Web must retain the Rust realtime gateway dependency");
  }

  return {
    renderedSha256: sha256(canonicalJson(rendered)),
    topology: {
      nodeRealtimeLoopback: `127.0.0.1:${nodePort}`,
      rustPublicPort: 8081,
      publicRealtimeOwner: "rust",
      nodeTrafficSharePercent: 0,
    },
    storageConfiguration: storageConfiguration(rendered),
  };
}

export function createRealtimeProofPreflight({ sourceState, selection, rendered, nodePort }) {
  assertObject(sourceState, "realtime proof source state");
  if (Object.keys(sourceState).sort().join(",") !== "clean,headSha") {
    throw new TypeError("realtime proof sourceState must contain exactly clean and headSha");
  }
  if (sourceState.clean !== true) {
    throw new TypeError("realtime release proof requires a clean source checkout");
  }
  if (typeof sourceState.headSha !== "string" || !sourceShaPattern.test(sourceState.headSha)) {
    throw new TypeError("realtime proof headSha must be a full lower-case Git SHA");
  }
  const selected = assertReleaseDeploymentSelection(selection);
  if (sourceState.headSha !== selected.candidate.sourceSha) {
    throw new TypeError("checked-out source must equal the selected candidate SHA");
  }
  const validated = validateRealtimeProofRenderedTopology({ rendered, selection: selected, nodePort });
  return {
    sourceState: { ...sourceState },
    sourceSha: selected.candidate.sourceSha,
    ...validated,
  };
}

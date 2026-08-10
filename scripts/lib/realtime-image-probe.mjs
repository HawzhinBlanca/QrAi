import { createHash } from "node:crypto";

import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./release-deployment.mjs";
import { AUDIO_LIMITS } from "../../server/src/realtime/audio.mjs";
import { parseAudioAck } from "../../server/src/realtime/protocol.mjs";

const sourceShaPattern = /^[a-f0-9]{40}$/;
const expectedOwnerPattern = /^\d{12}$/;
const storageServices = Object.freeze(["node-api", "job-worker", "node-realtime"]);
const audioProbeResultFields = Object.freeze(["accepted", "ackLatencyMs", "sequence"]);
const audioProbeResultFieldSet = new Set(audioProbeResultFields);
const minimumProbeTimeoutMs = 50;
const maximumProbeTimeoutMs = 30_000;
const duplicateAckWindowMs = 25;
const maximumProbeSessionBytes = 256;
const maximumProbeTicketBytes = 16 * 1024;
const maximumProbeTraceBytes = 256;

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

function requiredProbeString(value, label, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw new TypeError(`realtime audio probe ${label} is required`);
  }
  return value;
}

function probeOrigin(value) {
  const selected = requiredProbeString(value, "origin", 2_048);
  let parsed;
  try {
    parsed = new URL(selected);
  } catch {
    throw new TypeError("realtime audio probe origin must be an exact HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== selected
  ) {
    throw new TypeError("realtime audio probe origin must be an exact HTTPS origin");
  }
  return selected;
}

function probePort(value) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new TypeError("realtime audio probe port must be a safe integer from 1024 through 65535");
  }
  return value;
}

function probeFrame(value) {
  let frame;
  if (Buffer.isBuffer(value)) frame = Buffer.from(value);
  else if (value instanceof ArrayBuffer) frame = Buffer.from(value.slice(0));
  else if (ArrayBuffer.isView(value)) {
    frame = Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else {
    throw new TypeError("realtime audio probe frame must be binary");
  }
  if (frame.byteLength > AUDIO_LIMITS.maxTransportBytes) {
    throw new TypeError("realtime audio probe frame exceeds the frozen transport boundary");
  }
  return frame;
}

function acknowledgementInput(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return null;
}

function probeError(message) {
  return new Error(`realtime audio probe ${message}`);
}

function percentile(values, proportion) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(proportion * ordered.length) - 1];
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

/**
 * Send one bounded binary frame to a loopback release-candidate endpoint and accept only the
 * frozen seven-field acknowledgement. The credential-bearing URL and peer fields stay inside this
 * function; callers receive only the delivery decision, sequence, and measured latency.
 */
export async function probeRealtimeAudioFrame({
  port,
  sessionId,
  ticket,
  origin,
  traceId,
  frame,
  expectedSequence,
  timeoutMs,
}) {
  const selectedPort = probePort(port);
  const selectedSession = requiredProbeString(sessionId, "session id", maximumProbeSessionBytes);
  const selectedTicket = requiredProbeString(ticket, "ticket", maximumProbeTicketBytes);
  const selectedOrigin = probeOrigin(origin);
  if (
    traceId !== null &&
    (
      typeof traceId !== "string" ||
      traceId.trim() === "" ||
      traceId !== traceId.trim() ||
      Buffer.byteLength(traceId) > maximumProbeTraceBytes
    )
  ) {
    throw new TypeError("realtime audio probe trace id must be null or a non-empty string");
  }
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
    throw new TypeError("realtime audio probe expected sequence must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < minimumProbeTimeoutMs ||
    timeoutMs > maximumProbeTimeoutMs
  ) {
    throw new TypeError(
      `realtime audio probe timeout must be ${minimumProbeTimeoutMs}..${maximumProbeTimeoutMs} milliseconds`,
    );
  }
  const selectedFrame = probeFrame(frame);
  if (typeof globalThis.WebSocket !== "function") {
    throw new TypeError("realtime audio probe requires the Node WebSocket runtime");
  }

  const endpoint = new URL(`ws://127.0.0.1:${selectedPort}`);
  endpoint.pathname = `/v1/recitation-sessions/${encodeURIComponent(selectedSession)}/audio`;
  endpoint.searchParams.set("ticket", selectedTicket);
  if (traceId !== null) endpoint.searchParams.set("trace_id", traceId);

  return new Promise((resolve, reject) => {
    let socket;
    let timeout;
    let duplicateWindow;
    let sentAt = null;
    let result = null;
    let settled = false;

    const close = () => {
      try {
        socket?.close();
      } catch {
        // The bounded timeout remains authoritative even if the peer already closed.
      }
    };
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(duplicateWindow);
      close();
      if (error) reject(error);
      else resolve(Object.freeze(value));
    };

    try {
      // Node's built-in WebSocket accepts request headers without introducing a second transport
      // package. Origin is the only caller-controlled header and was reduced to an exact HTTPS
      // origin above.
      socket = new globalThis.WebSocket(endpoint, { headers: { Origin: selectedOrigin } });
    } catch {
      finish(probeError("transport failed"));
      return;
    }

    timeout = setTimeout(() => finish(probeError("timed out")), timeoutMs);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      sentAt = performance.now();
      try {
        socket.send(selectedFrame);
      } catch {
        finish(probeError("transport failed"));
      }
    };
    socket.onmessage = (event) => {
      if (result !== null) {
        finish(probeError("received multiple acknowledgements"));
        return;
      }
      const ack = parseAudioAck(acknowledgementInput(event.data));
      if (ack === null) {
        finish(probeError("received an invalid acknowledgement"));
        return;
      }
      if (
        ack.session_id !== selectedSession ||
        ack.sequence !== expectedSequence ||
        ack.trace_id !== traceId
      ) {
        finish(probeError("acknowledgement did not match the requested frame"));
        return;
      }
      if (sentAt === null) {
        finish(probeError("received an acknowledgement before sending a frame"));
        return;
      }
      result = {
        accepted: ack.accepted,
        ackLatencyMs: Math.max(0, performance.now() - sentAt),
        sequence: ack.sequence,
      };
      duplicateWindow = setTimeout(() => finish(null, result), duplicateAckWindowMs);
    };
    socket.onclose = () => {
      if (result !== null) finish(null, result);
      else finish(probeError("closed before acknowledgement"));
    };
    socket.onerror = () => {
      if (result !== null) finish(null, result);
      else finish(probeError("transport failed"));
    };
  });
}

/** Convert successful one-frame probes into the closed accounting used by W3.8 stage evidence. */
export function summarizeRealtimeAudioFrameProbes(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new TypeError("realtime audio probe results must be a non-empty array");
  }
  let accepted = 0;
  const latencies = [];
  for (const result of results) {
    assertObject(result, "realtime audio probe result");
    const keys = Object.keys(result);
    if (
      keys.length !== audioProbeResultFields.length ||
      !keys.every((key) => audioProbeResultFieldSet.has(key))
    ) {
      throw new TypeError("realtime audio probe result must have the exact aggregate shape");
    }
    if (typeof result.accepted !== "boolean") {
      throw new TypeError("realtime audio probe result accepted must be boolean");
    }
    if (!Number.isSafeInteger(result.sequence) || result.sequence < 0) {
      throw new TypeError("realtime audio probe result sequence is invalid");
    }
    if (!Number.isFinite(result.ackLatencyMs) || result.ackLatencyMs < 0) {
      throw new TypeError("realtime audio probe result latency is invalid");
    }
    if (result.accepted) accepted += 1;
    latencies.push(result.ackLatencyMs);
  }
  return {
    framesSent: results.length,
    accepted,
    rejected: results.length - accepted,
    lost: 0,
    uncertain: 0,
    ackP95Ms: percentile(latencies, 0.95),
    ackP99Ms: percentile(latencies, 0.99),
  };
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

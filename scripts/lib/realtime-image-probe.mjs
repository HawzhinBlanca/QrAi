import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import {
  assertReleaseDeploymentSelection,
  composeImageEnvironment,
} from "./release-deployment.mjs";
import { createHttpCanaryActorAuthorization } from "./http-canary-probe.mjs";
import { AUDIO_LIMITS } from "../../server/src/realtime/audio.mjs";
import { AUDIO_ACK_FIELDS, parseAudioAck } from "../../server/src/realtime/protocol.mjs";

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
const maximumParityResponseBytes = 64 * 1024;
const platformApiBaseUrl = "http://127.0.0.1:8080";
const rustRealtimePort = 8081;
const protocolParityRetentions = Object.freeze([
  "discard",
  "teacher-review",
  "training-opt-in",
]);
const ticketResponseFields = Object.freeze([
  "sessionId",
  "tenantId",
  "learnerId",
  "expiresAt",
  "allowedSampleRates",
  "externalAsrProcessing",
  "token",
  "auditEventId",
]);
const ticketResponseFieldSet = new Set(ticketResponseFields);

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

function parityError(message) {
  return new Error(`realtime protocol parity ${message}`);
}

function requiredParityString(value, label, maximumBytes = 256) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw new TypeError(`realtime protocol parity ${label} is required`);
  }
  return value;
}

function assertProbeTimeout(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimumProbeTimeoutMs ||
    value > maximumProbeTimeoutMs
  ) {
    throw new TypeError(
      `realtime audio probe timeout must be ${minimumProbeTimeoutMs}..${maximumProbeTimeoutMs} milliseconds`,
    );
  }
  return value;
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

/**
 * Prove a credential-bearing upgrade was refused with a bodyless security response. Node's
 * built-in WebSocket client intentionally hides non-101 response status, so this probe performs
 * only the bounded HTTP/1.1 handshake and never exposes the credential-bearing request target.
 */
export async function probeRealtimeUpgradeRefusal({
  port,
  sessionId,
  ticket,
  origin,
  expectedStatus,
  timeoutMs,
}) {
  const selectedPort = probePort(port);
  const selectedSession = requiredProbeString(sessionId, "session id", maximumProbeSessionBytes);
  const selectedTicket = requiredProbeString(ticket, "ticket", maximumProbeTicketBytes);
  const selectedOrigin = probeOrigin(origin);
  if (![401, 403].includes(expectedStatus)) {
    throw new TypeError("realtime audio probe refusal status must be 401 or 403");
  }
  const selectedTimeout = assertProbeTimeout(timeoutMs);
  const query = new URLSearchParams({ ticket: selectedTicket });
  const path = `/v1/recitation-sessions/${encodeURIComponent(selectedSession)}/audio?${query}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let request;
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.destroy();
      if (error) reject(error);
      else resolve(Object.freeze(value));
    };
    try {
      request = httpRequest({
        host: "127.0.0.1",
        port: selectedPort,
        method: "GET",
        path,
        headers: {
          Connection: "Upgrade",
          Origin: selectedOrigin,
          Upgrade: "websocket",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      });
    } catch {
      finish(probeError("refusal transport failed"));
      return;
    }
    timeout = setTimeout(() => finish(probeError("refusal timed out")), selectedTimeout);
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      finish(probeError("refusal unexpectedly upgraded"));
    });
    request.once("response", (response) => {
      let bodyBytes = 0;
      response.on("data", (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > 0) finish(probeError("refusal did not match the bodyless security boundary"));
      });
      response.once("end", () => {
        const contentLength = response.headers["content-length"];
        if (
          response.statusCode !== expectedStatus ||
          bodyBytes !== 0 ||
          (contentLength !== undefined && contentLength !== "0")
        ) {
          finish(probeError("refusal did not match the bodyless security boundary"));
          return;
        }
        finish(null, { refused: true, statusCode: expectedStatus });
      });
      response.once("aborted", () => finish(probeError("refusal transport failed")));
      response.once("error", () => finish(probeError("refusal transport failed")));
    });
    request.once("error", () => finish(probeError("refusal transport failed")));
    request.end();
  });
}

function exactObjectFields(value, fields, fieldSet) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fieldSet.has(key));
}

async function readBoundedParityJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumParityResponseBytes) {
    throw parityError("API response exceeded its byte limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw parityError("API response body was unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumParityResponseBytes) {
      await reader.cancel().catch(() => {});
      throw parityError("API response exceeded its byte limit");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

async function postParityJson({ fetchImpl, path, authorization, origin, body, timeoutMs, label }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${platformApiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        Origin: origin,
        "x-trace-id": `w3-8-realtime-proof-${randomUUID()}`,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response || response.status !== 200) {
      throw parityError(`${label} failed`);
    }
    return await readBoundedParityJson(response);
  } catch {
    throw parityError(`${label} failed`);
  } finally {
    clearTimeout(timeout);
  }
}

function validateIssuedTicket(value, { sessionId, tenantId, learnerId, nowUnixSeconds }) {
  if (!exactObjectFields(value, ticketResponseFields, ticketResponseFieldSet)) {
    throw parityError("ticket issuance failed");
  }
  const tokenParts = typeof value.token === "string" ? value.token.split(".") : [];
  const expiresAt = Number(value.expiresAt);
  if (
    value.sessionId !== sessionId ||
    value.tenantId !== tenantId ||
    value.learnerId !== learnerId ||
    typeof value.expiresAt !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.expiresAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowUnixSeconds ||
    expiresAt > nowUnixSeconds + 600 ||
    JSON.stringify(value.allowedSampleRates) !== "[16000]" ||
    value.externalAsrProcessing !== false ||
    typeof value.token !== "string" ||
    value.token !== value.token.trim() ||
    tokenParts.length !== 9 ||
    tokenParts[0] !== "rt_v2" ||
    tokenParts.some((part) => part === "") ||
    Buffer.byteLength(value.token) > maximumProbeTicketBytes ||
    typeof value.auditEventId !== "string" ||
    value.auditEventId.trim() === ""
  ) {
    throw parityError("ticket issuance failed");
  }
  return value.token;
}

function validateFrameProbeResult(value) {
  summarizeRealtimeAudioFrameProbes([value]);
  if (value.sequence !== 0) throw parityError("frame acknowledgement sequence mismatch");
  return value.accepted;
}

function validateRefusalProbeResult(value, expectedStatus) {
  const fields = ["refused", "statusCode"];
  if (
    !exactObjectFields(value, fields, new Set(fields)) ||
    value.refused !== true ||
    value.statusCode !== expectedStatus
  ) {
    throw parityError("upgrade refusal was not proven");
  }
}

/**
 * Exercise valid, deliberate-invalid, Origin, and replay behavior against the loopback Node
 * candidate and the still-public Rust oracle. All credentials and learner/session identity remain
 * process-local; the returned evidence is the exact aggregate protocol-parity measurement shape.
 */
export async function runRealtimeProtocolParityStage({
  nodePort,
  origin,
  disallowedOrigin,
  jwtSecret,
  tenantId,
  learnerId,
  fetchImpl = fetch,
  frameProbe = probeRealtimeAudioFrame,
  refusalProbe = probeRealtimeUpgradeRefusal,
  nowUnixSeconds = () => Math.floor(Date.now() / 1_000),
  timeoutMs,
}) {
  const selectedNodePort = probePort(nodePort);
  if (selectedNodePort === rustRealtimePort) {
    throw new TypeError("realtime protocol parity Node port must remain distinct from Rust port 8081");
  }
  const selectedOrigin = probeOrigin(origin);
  const selectedDisallowedOrigin = probeOrigin(disallowedOrigin);
  if (selectedOrigin === selectedDisallowedOrigin) {
    throw new TypeError("realtime protocol parity disallowed origin must be distinct");
  }
  const selectedTenant = requiredParityString(tenantId, "tenant id");
  const selectedLearner = requiredParityString(learnerId, "learner id");
  const selectedSecret = requiredParityString(jwtSecret, "JWT secret", 4_096);
  if (Buffer.byteLength(selectedSecret) < 32) {
    throw new TypeError("realtime protocol parity JWT secret must be at least 32 bytes");
  }
  if (typeof fetchImpl !== "function" || typeof frameProbe !== "function" || typeof refusalProbe !== "function") {
    throw new TypeError("realtime protocol parity adapters must be functions");
  }
  if (typeof nowUnixSeconds !== "function") {
    throw new TypeError("realtime protocol parity clock must be a function");
  }
  const selectedTimeout = assertProbeTimeout(timeoutMs);
  const authorization = await createHttpCanaryActorAuthorization({
    jwtSecret: selectedSecret,
    tenantId: selectedTenant,
    userId: selectedLearner,
    role: "learner",
  });
  const sessions = new Map();
  const sessionPromises = new Map();

  async function sessionFor(retention) {
    const cached = sessions.get(retention);
    if (cached) return cached;
    const pending = sessionPromises.get(retention);
    if (pending) return pending;
    const creation = (async () => {
      const body = await postParityJson({
        fetchImpl,
        path: "/v1/recitation-sessions",
        authorization,
        origin: selectedOrigin,
        timeoutMs: selectedTimeout,
        label: "session issuance",
        body: {
          learnerId: selectedLearner,
          quranRef: {
            surahNumber: 1,
            ayahStart: 1,
            ayahEnd: 7,
            display: "Al-Fatihah 1:1-7",
          },
          sourceChecksum: `declared:w3.8-realtime-production-proof:${retention}`,
          language: "ckb",
          mode: "guided-recite",
          practicePlanId: "w3.8-realtime-production-proof",
          consent: {
            recordingConsent: true,
            audioRetention: retention,
            anonymizedLearning: false,
            externalAsrProcessing: false,
            guardianApproved: false,
            consentVersion: "w3.8-realtime-production-proof-v1",
          },
        },
      });
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.id !== "string" ||
        body.id.trim() === "" ||
        body.tenantId !== selectedTenant ||
        body.learnerId !== selectedLearner ||
        body.consent?.audioRetention !== retention
      ) {
        throw parityError("session issuance failed");
      }
      sessions.set(retention, body.id);
      return body.id;
    })();
    sessionPromises.set(retention, creation);
    try {
      return await creation;
    } finally {
      sessionPromises.delete(retention);
    }
  }

  async function issueTicket(retention) {
    const sessionId = await sessionFor(retention);
    const body = await postParityJson({
      fetchImpl,
      path: "/v1/realtime-session-tickets",
      authorization,
      origin: selectedOrigin,
      timeoutMs: selectedTimeout,
      label: "ticket issuance",
      body: { sessionId, requestedSampleRates: [16_000] },
    });
    const currentSeconds = nowUnixSeconds();
    if (!Number.isSafeInteger(currentSeconds) || currentSeconds < 0) {
      throw new TypeError("realtime protocol parity clock returned an invalid time");
    }
    return {
      sessionId,
      ticket: validateIssuedTicket(body, {
        sessionId,
        tenantId: selectedTenant,
        learnerId: selectedLearner,
        nowUnixSeconds: currentSeconds,
      }),
    };
  }

  async function sendFrame(port, issued, frame) {
    const result = await frameProbe({
      port,
      sessionId: issued.sessionId,
      ticket: issued.ticket,
      origin: selectedOrigin,
      traceId: null,
      frame,
      expectedSequence: 0,
      timeoutMs: selectedTimeout,
    });
    return validateFrameProbeResult(result);
  }

  async function proveRefusal(port, issued, refusalOrigin, expectedStatus) {
    const result = await refusalProbe({
      port,
      sessionId: issued.sessionId,
      ticket: issued.ticket,
      origin: refusalOrigin,
      expectedStatus,
      timeoutMs: selectedTimeout,
    });
    validateRefusalProbeResult(result, expectedStatus);
  }

  let validCases = 0;
  let matchedCases = 0;
  let unexpectedDivergences = 0;
  for (const retention of protocolParityRetentions) {
    const [nodeTicket, rustTicket] = await Promise.all([
      issueTicket(retention),
      issueTicket(retention),
    ]);
    const [nodeAccepted, rustAccepted] = await Promise.all([
      sendFrame(selectedNodePort, nodeTicket, Buffer.alloc(AUDIO_LIMITS.frameBytes)),
      sendFrame(rustRealtimePort, rustTicket, Buffer.alloc(AUDIO_LIMITS.frameBytes)),
    ]);
    validCases += 1;
    if (nodeAccepted && rustAccepted) matchedCases += 1;
    else unexpectedDivergences += 1;
  }
  if (unexpectedDivergences !== 0 || matchedCases !== validCases) {
    throw parityError("valid wire behavior diverged");
  }

  const [nodeInvalidTicket, rustInvalidTicket] = await Promise.all([
    issueTicket("discard"),
    issueTicket("discard"),
  ]);
  const invalidFrame = Buffer.alloc(AUDIO_LIMITS.frameBytes - 1);
  const [nodeInvalidAccepted, rustInvalidAccepted] = await Promise.all([
    sendFrame(selectedNodePort, nodeInvalidTicket, invalidFrame),
    sendFrame(rustRealtimePort, rustInvalidTicket, invalidFrame),
  ]);
  if (nodeInvalidAccepted || !rustInvalidAccepted) {
    throw parityError("deliberate invalid-frame divergence was not proven");
  }

  let originRefusals = 0;
  for (const port of [selectedNodePort, rustRealtimePort]) {
    const issued = await issueTicket("discard");
    await proveRefusal(port, issued, selectedDisallowedOrigin, 403);
    originRefusals += 1;
    if (!await sendFrame(port, issued, Buffer.alloc(AUDIO_LIMITS.frameBytes))) {
      throw parityError("origin refusal consumed a single-use ticket");
    }
  }

  let replayRefusals = 0;
  for (const port of [selectedNodePort, rustRealtimePort]) {
    const issued = await issueTicket("discard");
    if (!await sendFrame(port, issued, Buffer.alloc(AUDIO_LIMITS.frameBytes))) {
      throw parityError("replay setup frame was not accepted");
    }
    await proveRefusal(port, issued, selectedOrigin, 401);
    replayRefusals += 1;
  }

  return Object.freeze({
    validCases,
    matchedCases,
    unexpectedDivergences,
    nodeInvalidFrameDivergences: 1,
    ackFieldCount: AUDIO_ACK_FIELDS.length,
    originRefusals,
    replayRefusals,
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

import { createIncomingRequestDeadline, isDeadlineError } from "../lib/deadline.mjs";
import {
  clampAuditLimit,
  clampAuditOffset,
  deletePrivacy,
  exportPrivacy,
  getAuditEvents,
  readAudioObject,
  storeAudioChunk,
} from "./runtime.mjs";

const MAX_JSON_CHARS = 5_000_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;

function positiveWhole(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function json(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > MAX_JSON_CHARS) {
        request.pause();
        settle(reject, Object.assign(new Error("request body too large"), { status: 413 }));
      }
    });
    request.on("end", () => {
      if (!data.trim()) return settle(resolve, {});
      try {
        settle(resolve, JSON.parse(data));
      } catch {
        settle(reject, Object.assign(new Error("request body is not valid JSON"), { status: 400 }));
      }
    });
    request.on("error", (error) => settle(reject, error));
  });
}

export function createCompatibilityIngress({
  audioObjectStore,
  inference,
  mlApiKey,
  operationTimeoutMs,
  anonymousRateLimit = 100,
  trustedRateLimit = 6_000,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  trustProxyHeaders = false,
  now = Date.now,
  log = () => {},
}) {
  if (!audioObjectStore || typeof audioObjectStore.put !== "function" || typeof audioObjectStore.get !== "function") {
    throw new TypeError("compatibility ingress requires an audio object store");
  }
  if (
    !inference ||
    typeof inference.predictAlignment !== "function" ||
    typeof inference.predictTajweed !== "function" ||
    typeof inference.transcribeSession !== "function"
  ) {
    throw new TypeError("compatibility ingress requires a local inference runtime");
  }
  required(mlApiKey, "mlApiKey");
  positiveWhole(operationTimeoutMs, "operationTimeoutMs");
  positiveWhole(anonymousRateLimit, "anonymousRateLimit");
  positiveWhole(trustedRateLimit, "trustedRateLimit");
  positiveWhole(rateWindowMs, "rateWindowMs");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof log !== "function") throw new TypeError("log must be a function");

  const postPaths = new Set([
    "/v1/alignments:predict",
    "/v1/audio-chunks",
    "/v1/audio-objects:read",
    "/v1/privacy/delete",
    "/v1/privacy/export",
    "/v1/session-transcript",
    "/v1/tajweed-findings:predict",
  ]);
  const getPaths = new Set(["/v1/audit-events"]);
  const knownPaths = new Set([...postPaths, ...getPaths]);
  const requestsByBucket = new Map();

  function admitted(bucket, limit) {
    const current = now();
    const cutoff = current - rateWindowMs;
    const timestamps = (requestsByBucket.get(bucket) ?? []).filter((at) => at > cutoff);
    if (timestamps.length >= limit) return false;
    timestamps.push(current);
    requestsByBucket.set(bucket, timestamps);
    return true;
  }

  return async function compatibilityIngress(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!knownPaths.has(url.pathname)) return false;
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return true;
    }
    if (
      (request.method !== "POST" || !postPaths.has(url.pathname)) &&
      (request.method !== "GET" || !getPaths.has(url.pathname))
    ) {
      return false;
    }

    const authenticated = request.headers["x-ml-api-key"] === mlApiKey;
    const forwardedFor = trustProxyHeaders
      ? request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
      : null;
    const clientIp = forwardedFor || request.socket.remoteAddress || "unknown";
    const bucket = authenticated ? `trusted:${clientIp}` : `ip:${clientIp}`;
    if (!admitted(bucket, authenticated ? trustedRateLimit : anonymousRateLimit)) {
      json(response, 429, { error: "Too many requests. Please try again later." });
      return true;
    }
    if (!authenticated) {
      json(response, 401, { error: "unauthorized" });
      return true;
    }

    const deadline = createIncomingRequestDeadline(request, response, operationTimeoutMs);
    try {
      let result;
      if (url.pathname === "/v1/audit-events") {
        const tenantId = url.searchParams.get("tenantId");
        if (!tenantId) {
          throw Object.assign(new Error("tenantId query parameter is required"), { status: 400 });
        }
        const all = getAuditEvents(tenantId).reverse();
        const limit = clampAuditLimit(url.searchParams.get("limit"));
        const offset = clampAuditOffset(url.searchParams.get("offset"));
        const page = all.slice(offset, offset + limit);
        response.setHeader("x-total-count", String(all.length));
        response.setHeader("x-truncated", String(offset + page.length < all.length));
        result = page;
      } else {
        const requestBody = await readJson(request);
        switch (url.pathname) {
          case "/v1/alignments:predict":
            result = await inference.predictAlignment(requestBody, deadline);
            break;
          case "/v1/audio-chunks":
            result = await storeAudioChunk(requestBody, deadline, audioObjectStore);
            break;
          case "/v1/audio-objects:read":
            result = await readAudioObject(requestBody, deadline, audioObjectStore);
            break;
          case "/v1/privacy/delete":
            result = await deletePrivacy(requestBody, deadline, audioObjectStore);
            break;
          case "/v1/privacy/export":
            result = await exportPrivacy(requestBody, deadline, audioObjectStore);
            break;
          case "/v1/session-transcript":
            result = await inference.transcribeSession(requestBody, deadline);
            break;
          case "/v1/tajweed-findings:predict":
            result = await inference.predictTajweed(requestBody, deadline);
            break;
          default:
            return false;
        }
      }
      json(response, 200, result);
    } catch (error) {
      if (isDeadlineError(error)) {
        response.setHeader("retry-after", "1");
        json(response, 503, { error: "dependency operation timed out" });
      } else {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        if (status >= 500) log("compatibility ingress failed");
        json(response, status, { error: status >= 500 ? "internal error" : error.message });
      }
    }
    return true;
  };
}

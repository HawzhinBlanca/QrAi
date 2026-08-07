import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { SignJWT } from "jose";

import { retainedCanaryRouteKeys } from "../../server/src/routes/canary.mjs";
import { ROUTES } from "../../server/src/routes/index.mjs";

export const TRANSITION_CANARY_ROUTE_KEYS = Object.freeze([
  "GET /v1/agent-runs",
  "POST /v1/agent-runs",
  "POST /v1/auth/login",
  "POST /v1/auth/register",
]);

const OWNER_HEADER = "x-qrai-route-owner";

export function loadHttpCanaryRouteKeys() {
  const manifestUrl = new URL("../../packages/contracts/route-manifest.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  return retainedCanaryRouteKeys(manifest, ROUTES);
}

function assertBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("HTTP canary baseUrl must be an absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("HTTP canary baseUrl must be an http(s) URL without credentials");
  }
  return url.toString().replace(/\/$/, "");
}

function materializePath(path) {
  return path
    .replaceAll("{surah_number}", "1")
    .replaceAll("{ayah_number}", "1")
    .replaceAll("{model_version}", "canary-missing-model")
    .replaceAll("{id}", "canary-missing-id");
}

function requestForRoute(key) {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator);
  const path = materializePath(key.slice(separator + 1));
  return {
    method,
    path,
    headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  };
}

function routeOwner(response) {
  return response.headers?.get?.(OWNER_HEADER) ?? null;
}

async function request(fetchImpl, baseUrl, request) {
  return fetchImpl(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
  });
}

export async function runHttpCanaryRouteProbe({
  baseUrl,
  rustAvailable,
  fetchImpl = fetch,
  routeKeys = loadHttpCanaryRouteKeys(),
  transitionRouteKeys = TRANSITION_CANARY_ROUTE_KEYS,
}) {
  const target = assertBaseUrl(baseUrl);
  if (typeof rustAvailable !== "boolean") {
    throw new TypeError("rustAvailable must be boolean");
  }
  const expectedRoutes = loadHttpCanaryRouteKeys();
  if (JSON.stringify(routeKeys) !== JSON.stringify(expectedRoutes)) {
    throw new TypeError("routeKeys must equal the exact retained canary route inventory");
  }
  if (JSON.stringify(transitionRouteKeys) !== JSON.stringify(TRANSITION_CANARY_ROUTE_KEYS)) {
    throw new TypeError("transitionRouteKeys must equal the exact Rust transition inventory");
  }

  const observations = [];
  let retainedFallbacks = 0;
  for (const key of routeKeys) {
    const probe = requestForRoute(key);
    const response = await request(fetchImpl, target, probe);
    const owner = routeOwner(response);
    if (owner !== "node-local") retainedFallbacks += 1;
    observations.push({ key, owner, status: response.status });
  }
  if (retainedFallbacks !== 0) {
    throw new Error(`${retainedFallbacks} retained route(s) did not prove Node-local ownership`);
  }

  let transitionDependencyFailures = 0;
  for (const key of transitionRouteKeys) {
    const probe = requestForRoute(key);
    const response = await request(fetchImpl, target, probe);
    const owner = routeOwner(response);
    if (owner !== "rust-compatibility") {
      throw new Error(`${key} did not prove Rust compatibility ownership`);
    }
    if (rustAvailable && response.status === 502) {
      throw new Error(`${key} could not reach the live Rust compatibility oracle`);
    }
    if (!rustAvailable && response.status === 502) transitionDependencyFailures += 1;
    observations.push({ key, owner, status: response.status });
  }
  if (!rustAvailable && transitionDependencyFailures !== transitionRouteKeys.length) {
    throw new Error("every transition route must fail with 502 while the Rust oracle is unavailable");
  }

  return {
    rustAvailable,
    retainedAttempted: routeKeys.length,
    retainedFallbacks,
    transitionAttempted: transitionRouteKeys.length,
    transitionDependencyFailures,
    routeKeys: [...routeKeys],
    transitionRouteKeys: [...transitionRouteKeys],
    observations,
  };
}

export async function createHttpCanaryActorAuthorization({ jwtSecret, tenantId, userId, role }) {
  if (typeof jwtSecret !== "string" || jwtSecret.length === 0) {
    throw new TypeError("jwtSecret is required for authenticated image probes");
  }
  const now = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({ tenant_id: tenantId, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(jwtSecret));
  return `Bearer ${token}`;
}

export async function runHttpCanaryHostileProbe({
  baseUrl,
  jwtSecret = "test-only-secret",
  tenantId = "hikmah-pilot-erbil",
  fetchImpl = fetch,
}) {
  const target = assertBaseUrl(baseUrl);
  const authorization = await createHttpCanaryActorAuthorization({
    jwtSecret,
    tenantId,
    userId: "learner-1",
    role: "learner",
  });
  const identityHeaders = {
    authorization,
    "content-type": "application/json",
    "x-trace-id": `canary-hostile-${randomUUID()}`,
  };
  const nul = String.fromCharCode(0);
  const probes = [
    {
      label: "nul-text",
      method: "POST",
      path: "/v1/learner/progress",
      headers: identityHeaders,
      body: JSON.stringify({ quality: 4, ayahRef: `1:1${nul}x` }),
      status: 400,
    },
    {
      label: "malformed-json",
      method: "POST",
      path: "/v1/learner/progress",
      headers: identityHeaders,
      body: "{",
    },
    {
      label: "oversized-body",
      method: "POST",
      path: "/v1/learner/progress",
      headers: identityHeaders,
      body: JSON.stringify({ quality: 4, ayahRef: "x".repeat(2 * 1024 * 1024) }),
      status: 413,
    },
    {
      label: "integer-overflow",
      method: "GET",
      path: "/v1/quran/surahs/2147483648",
      headers: identityHeaders,
    },
    {
      label: "encoded-path-traversal",
      method: "GET",
      path: "/v1/eval-runs/..%2f..%2fetc%2fpasswd",
      headers: identityHeaders,
    },
  ];

  const observations = [];
  for (const probe of probes) {
    const response = await request(fetchImpl, target, probe);
    const owner = routeOwner(response);
    if (owner !== "node-local") {
      throw new Error(`${probe.label} did not prove Node-local ownership`);
    }
    if (response.status >= 500) {
      throw new Error(`${probe.label} produced a server failure (${response.status})`);
    }
    if (probe.status !== undefined && response.status !== probe.status) {
      throw new Error(`${probe.label} expected ${probe.status}, got ${response.status}`);
    }
    observations.push({ label: probe.label, owner, status: response.status });
  }
  return { attempted: probes.length, serverFailures: 0, observations };
}

async function jsonRequest(fetchImpl, target, path, { authorization, body, headers = {} }) {
  const response = await request(fetchImpl, target, {
    method: "POST",
    path,
    headers: {
      authorization,
      "content-type": "application/json",
      "x-trace-id": `canary-audio-${randomUUID()}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (routeOwner(response) !== "node-local") {
    throw new Error(`${path} did not prove Node-local ownership`);
  }
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return parsed;
}

export async function runHttpCanaryAudioIndexProbe({
  baseUrl,
  jwtSecret,
  tenantId = "hikmah-pilot-erbil",
  fetchImpl = fetch,
}) {
  const target = assertBaseUrl(baseUrl);
  const authorization = await createHttpCanaryActorAuthorization({
    jwtSecret,
    tenantId,
    userId: "learner-1",
    role: "learner",
  });
  const session = await jsonRequest(fetchImpl, target, "/v1/recitation-sessions", {
    authorization,
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
      sourceChecksum: "fnv1a32:http-canary-image",
      modelVersion: "model-v0.3",
      language: "ckb",
      consent: {
        audioRetention: "teacher-review",
        anonymizedLearning: false,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  if (typeof session?.id !== "string") throw new Error("audio probe session id is missing");

  const ticket = await jsonRequest(fetchImpl, target, "/v1/realtime-session-tickets", {
    authorization,
    body: { sessionId: session.id, requestedSampleRates: [16_000] },
  });
  if (typeof ticket?.token !== "string") throw new Error("audio probe ticket is missing");

  const chunkId = `chunk-http-canary-${randomUUID()}`;
  const indexed = await jsonRequest(fetchImpl, target, "/v1/audio-chunks", {
    authorization,
    headers: { "x-realtime-ticket": ticket.token },
    body: {
      sessionId: session.id,
      chunkId,
      startMs: 0,
      endMs: 250,
      sampleRate: 16_000,
    },
  });
  if (indexed?.indexed !== true || indexed?.chunkId !== chunkId) {
    throw new Error("audio chunk was not durably indexed by the candidate");
  }
  return { sessionId: session.id, chunkId, indexed: true };
}

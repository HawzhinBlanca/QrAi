import { pathToFileURL } from "node:url";

import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";

import { createDb } from "../lib/db.mjs";
import { metricsAccessAllowed } from "../lib/metrics.mjs";
import {
  installProcessShutdown,
  parseShutdownGraceSeconds,
  shutdownPhases,
} from "../lib/shutdown.mjs";
import { createAudioObjectStoreFromEnv } from "../storage/audio-object-store.mjs";
import { createRealtimeAdmission } from "./admission.mjs";
import { AUDIO_LIMITS, createRealtimeAudioRuntime } from "./audio.mjs";
import { createRealtimeReplayAuthority } from "./replay.mjs";

const READINESS_DEPENDENCIES = Object.freeze([
  "postgres",
  "object_store",
  "worker",
  "asr",
]);

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function whole(raw, name, minimum, maximum, fallback) {
  const value = raw ?? String(fallback);
  if (!/^[0-9]+$/.test(value)) throw new TypeError(`${name} must be a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBind(raw = "127.0.0.1:8081") {
  const separator = raw.lastIndexOf(":");
  if (separator <= 0 || raw.indexOf(":") !== separator) {
    throw new TypeError("NODE_REALTIME_BIND must be host:port");
  }
  const host = raw.slice(0, separator);
  const port = whole(raw.slice(separator + 1), "NODE_REALTIME_BIND port", 1, 65_535, 8081);
  if (host.trim() !== host || /[\s/]/.test(host)) {
    throw new TypeError("NODE_REALTIME_BIND host is invalid");
  }
  return { host, port };
}

function dependencyReadyUrl(raw, name, fallback) {
  let url;
  try {
    url = new URL(required(raw ?? fallback, name));
  } catch {
    throw new TypeError(`${name} must be an HTTP service base URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new TypeError(`${name} must be an uncredentialed HTTP service base URL`);
  }
  url.pathname = "/ready";
  return url.toString();
}

function strictSwitch(raw, name) {
  const value = raw ?? "";
  if (typeof value !== "string" || value.trim() !== value) {
    throw new TypeError(`${name} must be an explicit boolean switch`);
  }
  if (["", "0", "false"].includes(value)) return false;
  if (["1", "true"].includes(value)) return true;
  throw new TypeError(`${name} must be 1/true or 0/false/unset`);
}

function parseAllowedOrigins(raw = "") {
  if (typeof raw !== "string") throw new TypeError("CORS_ALLOWED_ORIGINS must be a string");
  if (raw === "") return Object.freeze([]);
  const origins = raw.split(",");
  const seen = new Set();
  for (const origin of origins) {
    if (origin === "" || origin.trim() !== origin) {
      throw new TypeError("CORS_ALLOWED_ORIGINS entries must be non-empty canonical Origins");
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("CORS_ALLOWED_ORIGINS entries must be canonical HTTP Origins");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new TypeError("CORS_ALLOWED_ORIGINS entries must be canonical HTTP Origins");
    }
    if (seen.has(origin)) throw new TypeError("CORS_ALLOWED_ORIGINS entries must be unique");
    seen.add(origin);
  }
  return Object.freeze(origins);
}

function parseTrustedProxyHops(env) {
  const enabled = strictSwitch(env.TRUST_PROXY_HEADERS, "TRUST_PROXY_HEADERS");
  const rawHops = env.TRUST_PROXY_HOPS ?? "";
  if (!enabled) {
    if (rawHops !== "") throw new TypeError("TRUST_PROXY_HOPS requires TRUST_PROXY_HEADERS=1");
    return 0;
  }
  return whole(rawHops || "1", "TRUST_PROXY_HOPS", 1, 32, 1);
}

function productionTicketSecret(raw) {
  const secret = required(raw, "REALTIME_GATEWAY_TICKET_SECRET");
  if (
    secret === "smoke-secret" ||
    secret === "production-secret-change-me" ||
    secret.length < 32
  ) {
    throw new TypeError("REALTIME_GATEWAY_TICKET_SECRET must be a strong non-default value");
  }
  return secret;
}

export function parseRealtimeConfig(env = process.env) {
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL");
  const ticketSecret = productionTicketSecret(env.REALTIME_GATEWAY_TICKET_SECRET);
  const tenantId = required(env.GATEWAY_TENANT_ID, "GATEWAY_TENANT_ID");
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS ?? "");
  const allowMissingOrigin = strictSwitch(
    env.GATEWAY_ALLOW_MISSING_ORIGIN,
    "GATEWAY_ALLOW_MISSING_ORIGIN",
  );
  const rateLimitEnabled = !strictSwitch(env.DISABLE_RATE_LIMIT, "DISABLE_RATE_LIMIT");
  const trustedProxyHops = parseTrustedProxyHops(env);
  const { host, port } = parseBind(env.NODE_REALTIME_BIND ?? "127.0.0.1:8081");
  const readinessTimeoutMs = whole(
    env.REALTIME_READINESS_TIMEOUT_MS,
    "REALTIME_READINESS_TIMEOUT_MS",
    10,
    30_000,
    2_000,
  );
  const shutdownGraceMs = parseShutdownGraceSeconds(env.SHUTDOWN_GRACE_SECS ?? "8");
  const workerReadyUrl = dependencyReadyUrl(
    env.ML_INFERENCE_URL,
    "ML_INFERENCE_URL",
    "http://127.0.0.1:8098",
  );
  const asrReadyUrl = dependencyReadyUrl(
    env.ASR_SERVICE_URL,
    "ASR_SERVICE_URL",
    "http://127.0.0.1:8091",
  );
  const metricsToken = env.METRICS_TOKEN?.trim() || null;
  const metricsDevOpen = ["1", "true"].includes(env.METRICS_DEV_OPEN ?? "");
  return Object.freeze({
    asrReadyUrl,
    allowedOrigins,
    allowMissingOrigin,
    databaseUrl,
    host,
    metricsDevOpen,
    metricsToken,
    port,
    rateLimitEnabled,
    readinessTimeoutMs,
    shutdownGraceMs,
    tenantId,
    ticketSecret,
    trustedProxyHops,
    workerReadyUrl,
  });
}

function assertDependencies({ db, audioObjectStore, fetchImpl }) {
  if (
    !db ||
    typeof db.assertRestrictedRole !== "function" ||
    typeof db.end !== "function"
  ) {
    throw new TypeError("realtime process requires the restricted database boundary");
  }
  if (
    !audioObjectStore ||
    typeof audioObjectStore.assertReady !== "function" ||
    typeof audioObjectStore.close !== "function" ||
    typeof audioObjectStore.put !== "function"
  ) {
    throw new TypeError("realtime process requires the private audio object-store boundary");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("realtime process requires a fetch implementation");
  }
}

async function httpReady(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  try {
    return response?.status === 200;
  } finally {
    await response?.body?.cancel?.();
  }
}

function renderMetrics({
  ready,
  draining,
  failures,
  admissionMetrics,
  audioMetrics,
  replayMetrics,
}) {
  let output = "# HELP realtime_process_ready Whether every realtime dependency is ready.\n";
  output += "# TYPE realtime_process_ready gauge\n";
  output += `realtime_process_ready ${ready ? 1 : 0}\n`;
  output += "# HELP realtime_process_draining Whether realtime admission is closing.\n";
  output += "# TYPE realtime_process_draining gauge\n";
  output += `realtime_process_draining ${draining ? 1 : 0}\n`;
  output += "# HELP realtime_readiness_failures_total Failed readiness checks by closed dependency class.\n";
  output += "# TYPE realtime_readiness_failures_total counter\n";
  for (const dependency of READINESS_DEPENDENCIES) {
    output += `realtime_readiness_failures_total{dependency="${dependency}"} ${failures[dependency]}\n`;
  }
  return output + admissionMetrics + replayMetrics + audioMetrics;
}

export function createRealtimeApplication({
  db,
  audioObjectStore,
  workerReadyUrl,
  asrReadyUrl,
  readinessTimeoutMs,
  shutdownGraceMs,
  metricsToken = null,
  metricsDevOpen = false,
  ticketSecret,
  tenantId,
  allowedOrigins,
  allowMissingOrigin,
  rateLimitEnabled,
  trustedProxyHops,
  rateLimitOptions,
  admissionNowUnixSeconds,
  replayAuthority = null,
  handleAdmittedSocket = null,
  fetchImpl = globalThis.fetch,
  logger = false,
}) {
  assertDependencies({ db, audioObjectStore, fetchImpl });
  if (typeof workerReadyUrl !== "string" || typeof asrReadyUrl !== "string") {
    throw new TypeError("realtime dependency readiness URLs are required");
  }
  if (
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 10 ||
    readinessTimeoutMs > 30_000
  ) {
    throw new TypeError("realtime readiness timeout must be between 10 and 30000 milliseconds");
  }
  if (metricsToken !== null && (typeof metricsToken !== "string" || metricsToken === "")) {
    throw new TypeError("realtime metrics token must be null or a non-empty string");
  }
  if (typeof metricsDevOpen !== "boolean") {
    throw new TypeError("realtime metrics development control must be boolean");
  }
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 32) {
    throw new TypeError("realtime trusted proxy hops must be between 0 and 32");
  }
  if (handleAdmittedSocket !== null && typeof handleAdmittedSocket !== "function") {
    throw new TypeError("realtime admitted socket handler must be null or a function");
  }

  const replay = replayAuthority ?? createRealtimeReplayAuthority({ db, tenantId });
  if (
    !replay ||
    typeof replay.claim !== "function" ||
    typeof replay.start !== "function" ||
    typeof replay.stop !== "function" ||
    typeof replay.renderMetrics !== "function"
  ) {
    throw new TypeError("realtime process requires a complete durable replay authority");
  }

  const admission = createRealtimeAdmission({
    ticketSecret,
    tenantId,
    allowedOrigins,
    allowMissingOrigin,
    rateLimitEnabled,
    replayClaim: (claims) => replay.claim(claims),
    rateLimitOptions,
    nowUnixSeconds: admissionNowUnixSeconds,
  });
  const audio = createRealtimeAudioRuntime({ audioObjectStore, shutdownGraceMs });
  const admittedSocketHandler = handleAdmittedSocket ?? audio.handleSocket;

  const app = Fastify({
    logger,
    // The ticket is a query credential. Fastify's automatic request line includes the URL, so the
    // realtime boundary must never enable it even when application/error logging is configured.
    logController: new LogController({ disableRequestLogging: true }),
    forceCloseConnections: false,
    return503OnClosing: true,
    trustProxy: trustedProxyHops === 0 ? false : trustedProxyHops,
  });
  app.register(websocket, {
    options: { maxPayload: AUDIO_LIMITS.maxTransportBytes },
    errorHandler(_error, socket) {
      try {
        socket.close(1011, "internal error");
      } catch {
        socket.terminate?.();
      }
    },
    preClose: async function audioPreClose() {
      const errors = [];
      try {
        await audio.stop();
      } catch (error) {
        errors.push(error);
      }
      const server = this.websocketServer;
      for (const client of server.clients ?? []) {
        try {
          client.terminate();
        } catch {
          // The runtime already released this peer; server.close below remains authoritative.
        }
      }
      await new Promise((resolve) => {
        server.close((error) => {
          if (error) errors.push(error);
          resolve();
        });
      });
      if (errors.length > 0) {
        throw new AggregateError(errors, "realtime websocket close failed");
      }
    },
  });
  // Fastify's default 404 document echoes the requested URL. Keep near-miss credential-bearing
  // upgrade paths generic and bodyless, just like admission refusals.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send());
  const failures = Object.fromEntries(READINESS_DEPENDENCIES.map((name) => [name, 0]));
  let ready = false;
  let draining = false;
  let readinessPromise = null;

  async function checkReadiness() {
    if (draining) return false;
    if (readinessPromise !== null) return readinessPromise;
    readinessPromise = (async () => {
      const controller = new AbortController();
      const outcomes = Object.fromEntries(READINESS_DEPENDENCIES.map((name) => [name, false]));
      const checks = [
        ["postgres", () => db.assertRestrictedRole()],
        ["object_store", () => audioObjectStore.assertReady({ signal: controller.signal })],
        ["worker", () => httpReady(fetchImpl, workerReadyUrl, controller.signal)],
        ["asr", () => httpReady(fetchImpl, asrReadyUrl, controller.signal)],
      ];
      const completion = Promise.all(checks.map(async ([name, check]) => {
        try {
          outcomes[name] = (await check()) !== false;
        } catch {
          outcomes[name] = false;
        }
      }));
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, readinessTimeoutMs);
      });
      await Promise.race([completion, timedOut]);
      clearTimeout(timer);
      controller.abort();
      for (const name of READINESS_DEPENDENCIES) {
        if (!outcomes[name]) failures[name] += 1;
      }
      ready = !draining && READINESS_DEPENDENCIES.every((name) => outcomes[name]);
      return ready;
    })().finally(() => {
      readinessPromise = null;
    });
    return readinessPromise;
  }

  app.addHook("onReady", async () => {
    await db.assertRestrictedRole();
    await audioObjectStore.assertReady();
    await replay.start();
  });
  app.addHook("onClose", async () => {
    draining = true;
    ready = false;
    const errors = [];
    try {
      await audio.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await replay.stop();
    } catch (error) {
      errors.push(error);
    }
    const results = await Promise.allSettled([
      Promise.resolve().then(() => audioObjectStore.close()),
      Promise.resolve().then(() => db.end()),
    ]);
    errors.push(...results.filter(({ status }) => status === "rejected").map(({ reason }) => reason));
    if (errors.length > 0) throw new AggregateError(errors, "realtime resource close failed");
  });

  // Fastify processes plugins in registration order. Keep every route in a plugin registered
  // after @fastify/websocket so its onRoute hook sees the WebSocket declaration before boot.
  app.register(async function realtimeRoutes(routes) {
    routes.get("/health", async (_request, reply) => reply.type("text/plain").send("ok"));
    routes.get("/ready", async (_request, reply) => {
      const available = await checkReadiness();
      return reply.code(available ? 200 : 503).type("text/plain").send(
        available ? "ready" : "not ready",
      );
    });
    routes.get("/metrics", async (request, reply) => {
      if (!metricsAccessAllowed({ metricsToken, metricsDevOpen }, request.headers)) {
        return reply.code(404).send();
      }
      return reply
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(renderMetrics({
          ready,
          draining,
          failures,
          admissionMetrics: admission.renderMetrics(),
          audioMetrics: audio.renderMetrics(),
          replayMetrics: replay.renderMetrics(),
        }));
    });

    const admittedContext = Symbol("realtime-admission-context");
    routes.get(
      "/v1/recitation-sessions/:sessionId/audio",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          // The websocket plugin preserves a normal HTTP handler for non-upgrade requests. Only
          // apply admission policy to an actual WebSocket handshake; the HTTP surface remains 404.
          if (!request.ws) return;
          const query = request.query ?? {};
          const result = await admission.admit({
            sessionId: request.params?.sessionId,
            ticket: query.ticket,
            origin: request.headers.origin,
            clientIp: request.ip,
            traceId: query.trace_id,
          });
          if (!result.accepted) {
            if (result.retryAfterSeconds !== null) {
              reply.header("retry-after", String(result.retryAfterSeconds));
            }
            return reply.code(result.statusCode).send();
          }
          request[admittedContext] = result;
        },
      },
      (socket, request) => {
        try {
          admittedSocketHandler(socket, request[admittedContext]);
        } catch {
          try {
            socket.close(1011, "internal error");
          } catch {
            socket.terminate?.();
          }
        }
      },
    );
  });

  return app;
}

export async function startRealtimeProcess({
  env = process.env,
  processRef = process,
  fetchImpl = globalThis.fetch,
  logger = false,
} = {}) {
  const config = parseRealtimeConfig(env);
  const phases = shutdownPhases(config.shutdownGraceMs);
  const db = createDb(config.databaseUrl, {
    statementTimeoutMs: config.readinessTimeoutMs,
    closeTimeoutMs: phases.resourceCloseMs,
    connectTimeout: Math.max(1, Math.ceil(config.readinessTimeoutMs / 1_000)),
  });
  let audioObjectStore;
  let app;
  let shutdown;
  try {
    audioObjectStore = createAudioObjectStoreFromEnv({
      env,
      production: env.NODE_ENV === "production",
    });
    app = createRealtimeApplication({
      db,
      audioObjectStore,
      fetchImpl,
      logger,
      ...config,
    });
    shutdown = installProcessShutdown(app, {
      graceMs: config.shutdownGraceMs,
      processRef,
      role: "node realtime",
    });
    await app.listen({ host: config.host, port: config.port });
    return Object.freeze({ app, shutdown });
  } catch (error) {
    if (shutdown) {
      await shutdown.shutdown("startup-error", { exitCode: 2 });
    } else {
      await Promise.allSettled([
        Promise.resolve().then(() => audioObjectStore?.close()),
        Promise.resolve().then(() => db.end()),
      ]);
    }
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startRealtimeProcess().catch(() => {
    console.error("node realtime failed to start");
    process.exitCode = 2;
  });
}

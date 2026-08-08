import { pathToFileURL } from "node:url";

import Fastify from "fastify";

import { createDb } from "../lib/db.mjs";
import { metricsAccessAllowed } from "../lib/metrics.mjs";
import {
  installProcessShutdown,
  parseShutdownGraceSeconds,
  shutdownPhases,
} from "../lib/shutdown.mjs";
import { createAudioObjectStoreFromEnv } from "../storage/audio-object-store.mjs";

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

export function parseRealtimeConfig(env = process.env) {
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL");
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
    databaseUrl,
    host,
    metricsDevOpen,
    metricsToken,
    port,
    readinessTimeoutMs,
    shutdownGraceMs,
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
    typeof audioObjectStore.close !== "function"
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

function renderMetrics({ ready, draining, failures }) {
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
  return output;
}

export function createRealtimeApplication({
  db,
  audioObjectStore,
  workerReadyUrl,
  asrReadyUrl,
  readinessTimeoutMs,
  metricsToken = null,
  metricsDevOpen = false,
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

  const app = Fastify({
    logger,
    forceCloseConnections: false,
    return503OnClosing: true,
  });
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
  });
  app.addHook("onClose", async () => {
    draining = true;
    ready = false;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => audioObjectStore.close()),
      Promise.resolve().then(() => db.end()),
    ]);
    const rejected = results.filter(({ status }) => status === "rejected");
    if (rejected.length > 0) throw new AggregateError([], "realtime resource close failed");
  });

  app.get("/health", async (_request, reply) => reply.type("text/plain").send("ok"));
  app.get("/ready", async (_request, reply) => {
    const available = await checkReadiness();
    return reply.code(available ? 200 : 503).type("text/plain").send(
      available ? "ready" : "not ready",
    );
  });
  app.get("/metrics", async (request, reply) => {
    if (!metricsAccessAllowed({ metricsToken, metricsDevOpen }, request.headers)) {
      return reply.code(404).send();
    }
    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(renderMetrics({ ready, draining, failures }));
  });

  // W3.2 owns no WebSocket admission. Fastify otherwise leaves a raw upgrade socket open, so the
  // process answers with a fixed HTTP refusal and closes it. W3.3 must replace this listener when
  // it adds the actual admission boundary.
  const refuseUpgrade = (_request, socket) => {
    if (socket.destroyed) return;
    socket.end(
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  app.server.on("upgrade", refuseUpgrade);
  app.addHook("onClose", async () => app.server.removeListener("upgrade", refuseUpgrade));

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

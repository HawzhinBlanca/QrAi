import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { createAudioRetentionWorker } from "./inference/audio-retention.mjs";
import { createCompatibilityIngress } from "./inference/compatibility-ingress.mjs";
import { createInferenceRuntime } from "./inference/local.mjs";
import { createJobRuntime } from "./jobs/runtime.mjs";
import { createJobStore } from "./jobs/store.mjs";
import { createWorkflowHandlers } from "./jobs/workflows.mjs";
import { createDb } from "./lib/db.mjs";
import { metricsAccessAllowed } from "./lib/metrics.mjs";
import { parseShutdownGraceSeconds } from "./lib/shutdown.mjs";
import { createAudioObjectStoreFromEnv } from "./storage/audio-object-store.mjs";

const JOB_STATES = Object.freeze(["queued", "running", "retry", "dead"]);

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
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

function parseBind(raw = "127.0.0.1:8098") {
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) throw new TypeError("JOB_WORKER_BIND must be host:port");
  const host = raw.slice(0, separator);
  const port = whole(raw.slice(separator + 1), "JOB_WORKER_BIND port", 1, 65_535, 8098);
  if (host.trim() === "" || /[\s/]/.test(host)) throw new TypeError("JOB_WORKER_BIND host is invalid");
  return { host, port };
}

export function parseWorkerConfig(env = process.env) {
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL");
  const mlApiKey = required(env.ML_API_KEY, "ML_API_KEY");
  const { host, port } = parseBind(env.JOB_WORKER_BIND);
  const pollIntervalMs = whole(env.JOB_POLL_INTERVAL_MS, "JOB_POLL_INTERVAL_MS", 10, 60_000, 1_000);
  const operationSeconds = whole(
    env.JOB_OPERATION_TIMEOUT_SECS,
    "JOB_OPERATION_TIMEOUT_SECS",
    1,
    3_599,
    60,
  );
  const leaseSeconds = whole(env.JOB_LEASE_SECS, "JOB_LEASE_SECS", 1, 3_600, 65);
  const operationTimeoutMs = operationSeconds * 1_000;
  const leaseMs = leaseSeconds * 1_000;
  if (leaseMs <= operationTimeoutMs) {
    throw new TypeError("JOB_LEASE_SECS must exceed JOB_OPERATION_TIMEOUT_SECS");
  }
  const retryBaseMs = whole(env.JOB_RETRY_BASE_MS, "JOB_RETRY_BASE_MS", 1, 86_400_000, 1_000);
  const retryMaxMs = whole(env.JOB_RETRY_MAX_MS, "JOB_RETRY_MAX_MS", 1, 86_400_000, 300_000);
  if (retryBaseMs > retryMaxMs) throw new TypeError("JOB_RETRY_BASE_MS must not exceed JOB_RETRY_MAX_MS");
  const trustedRateLimit = whole(
    env.ML_TRUSTED_RATE_LIMIT_MAX,
    "ML_TRUSTED_RATE_LIMIT_MAX",
    1,
    10_000_000,
    6_000,
  );
  const shutdownGraceMs = parseShutdownGraceSeconds(env.SHUTDOWN_GRACE_SECS ?? "8");
  const metricsDevOpen = ["1", "true"].includes(env.METRICS_DEV_OPEN ?? "");
  const metricsToken = env.METRICS_TOKEN?.trim() || null;
  if (!metricsDevOpen && metricsToken === null) {
    throw new TypeError("METRICS_TOKEN is required unless METRICS_DEV_OPEN is explicit");
  }
  return Object.freeze({
    databaseUrl,
    host,
    leaseMs,
    metricsDevOpen,
    metricsToken,
    mlApiKey,
    operationTimeoutMs,
    pollIntervalMs,
    port,
    retryBaseMs,
    retryMaxMs,
    shutdownGraceMs,
    trustedRateLimit,
  });
}

function renderStateMetrics(totals, runtime) {
  let output = "# HELP job_state Current durable jobs by closed lifecycle state.\n";
  output += "# TYPE job_state gauge\n";
  for (const status of JOB_STATES) output += `job_state{status="${status}"} ${totals[status]}\n`;
  return output + runtime.renderMetrics();
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

export function createJobWorker({
  db,
  store,
  runtime,
  audioObjectStore = null,
  compatibilityIngress = null,
  retention = null,
  host,
  port,
  pollIntervalMs,
  shutdownGraceMs,
  metricsToken,
  metricsDevOpen,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  if (!db || typeof db.listTenantIds !== "function" || typeof db.assertRestrictedRole !== "function") {
    throw new TypeError("createJobWorker requires a restricted database boundary");
  }
  if (!store || typeof store.summary !== "function") throw new TypeError("createJobWorker requires a job store");
  if (!runtime || typeof runtime.runOne !== "function" || typeof runtime.drain !== "function") {
    throw new TypeError("createJobWorker requires a job runtime");
  }
  if (audioObjectStore && (
    typeof audioObjectStore.assertReady !== "function" || typeof audioObjectStore.close !== "function"
  )) {
    throw new TypeError("worker audio storage boundary is invalid");
  }
  if (compatibilityIngress !== null && typeof compatibilityIngress !== "function") {
    throw new TypeError("worker compatibility ingress must be a function");
  }
  if (retention && (typeof retention.start !== "function" || typeof retention.stop !== "function")) {
    throw new TypeError("worker retention boundary is invalid");
  }
  whole(String(port), "worker port", 0, 65_535, 0);
  whole(String(pollIntervalMs), "pollIntervalMs", 1, 60_000, 1_000);
  whole(String(shutdownGraceMs), "shutdownGraceMs", 1, 300_000, 8_000);
  if (typeof host !== "string" || host.trim() === "") throw new TypeError("worker host is required");
  if (typeof log !== "function") throw new TypeError("worker log must be a function");

  let draining = false;
  let started = false;
  let ready = false;
  let timer = null;
  let pollPromise = null;
  let shutdownPromise = null;
  let cursor = 0;
  let url = null;
  let totals = Object.fromEntries(JOB_STATES.map((status) => [status, 0]));

  async function readiness() {
    if (draining) return false;
    try {
      await db.assertRestrictedRole();
      if (audioObjectStore) await audioObjectStore.assertReady();
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, "ok");
    if (request.method === "GET" && request.url === "/ready") {
      const available = ready && await readiness();
      return send(response, available ? 200 : 503, available ? "ready" : "not ready");
    }
    if (request.method === "GET" && request.url === "/metrics") {
      if (!metricsAccessAllowed({ metricsToken, metricsDevOpen }, request.headers)) {
        response.writeHead(404);
        return response.end();
      }
      return send(
        response,
        200,
        renderStateMetrics(totals, runtime),
        "text/plain; version=0.0.4; charset=utf-8",
      );
    }
    if (compatibilityIngress && await compatibilityIngress(request, response)) return;
    return send(response, 404, "not found");
  });

  function schedule(milliseconds) {
    if (draining) return;
    timer = setTimeout(() => {
      pollPromise = poll().finally(() => { pollPromise = null; });
    }, milliseconds);
  }

  async function poll() {
    if (draining) return;
    try {
      const tenants = await db.listTenantIds();
      let worked = false;
      if (tenants.length > 0) {
        const start = cursor % tenants.length;
        cursor = (start + 1) % tenants.length;
        for (let index = 0; index < tenants.length && !draining; index += 1) {
          const tenantId = tenants[(start + index) % tenants.length];
          const outcome = await runtime.runOne(tenantId);
          if (outcome.outcome !== "idle") worked = true;
        }
      }
      const next = Object.fromEntries(JOB_STATES.map((status) => [status, 0]));
      for (const tenantId of tenants) {
        if (draining) break;
        const summary = await store.summary({ tenantId });
        for (const status of JOB_STATES) next[status] += Number(summary[status] ?? 0);
      }
      totals = next;
      ready = true;
      schedule(worked ? 0 : pollIntervalMs);
    } catch {
      ready = false;
      log("job worker poll failed");
      schedule(pollIntervalMs);
    }
  }

  async function start() {
    if (started) return;
    await db.assertRestrictedRole();
    if (audioObjectStore) await audioObjectStore.assertReady();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      if (retention) await retention.start();
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve()));
      throw error;
    }
    const address = server.address();
    url = `http://${host}:${address.port}`;
    started = true;
    ready = true;
    schedule(0);
  }

  function shutdown(reason = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    ready = false;
    if (timer !== null) clearTimeout(timer);
    log(`job worker shutdown started reason=${reason}`);
    shutdownPromise = (async () => {
      const closeServer = started
        ? new Promise((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      if (retention) {
        const stopped = await retention.stop({
          timeoutMs: Math.max(1, Math.floor(shutdownGraceMs * 0.2)),
        });
        if (!stopped) log("audio retention shutdown exceeded its bound");
      }
      await runtime.drain({ timeoutMs: Math.max(1, Math.floor(shutdownGraceMs * 0.5)) });
      if (pollPromise) await pollPromise;
      await closeServer;
      if (audioObjectStore) await audioObjectStore.close();
      await db.end();
      log("job worker shutdown complete");
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    get isDraining() { return draining; },
    get url() { return url; },
    shutdownGraceMs,
    start,
    shutdown,
  });
}

export function installWorkerSignals(
  controller,
  { processRef = process, log = (message) => processRef.stderr.write(`${message}\n`) } = {},
) {
  if (!controller || typeof controller.shutdown !== "function") {
    throw new TypeError("installWorkerSignals requires a worker controller");
  }
  let signalStarted = false;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (signalStarted) return;
      signalStarted = true;
      const hard = setTimeout(() => {
        log("job worker shutdown hard deadline exceeded");
        if (typeof processRef.exit === "function") processRef.exit(1);
        else processRef.exitCode = 1;
      }, controller.shutdownGraceMs ?? 8_000);
      void controller.shutdown(signal).then(() => {
        clearTimeout(hard);
        processRef.exitCode = 0;
      }).catch(() => {
        clearTimeout(hard);
        processRef.exitCode = 1;
        log("job worker shutdown failed");
      });
    };
    handlers.set(signal, handler);
    processRef.on(signal, handler);
  }
  return Object.freeze({
    dispose() {
      for (const [signal, handler] of handlers) processRef.removeListener(signal, handler);
    },
  });
}

async function main() {
  const config = parseWorkerConfig(process.env);
  const db = createDb(config.databaseUrl, {
    statementTimeoutMs: Math.min(10_000, config.operationTimeoutMs),
    closeTimeoutMs: Math.max(1, Math.floor(config.shutdownGraceMs / 5)),
  });
  const audioObjectStore = createAudioObjectStoreFromEnv({
    env: process.env,
    production: process.env.NODE_ENV === "production",
  });
  const store = createJobStore({ db });
  const inference = createInferenceRuntime({ audioObjectStore });
  const compatibilityIngress = createCompatibilityIngress({
    audioObjectStore,
    inference,
    mlApiKey: config.mlApiKey,
    operationTimeoutMs: config.operationTimeoutMs,
    anonymousRateLimit: 100,
    trustedRateLimit: config.trustedRateLimit,
  });
  const retention = createAudioRetentionWorker({ audioObjectStore });
  const workflowContext = {
    db,
    mlApiKey: config.mlApiKey,
    audioObjectStore,
    upstreamTimeoutMs: config.operationTimeoutMs,
  };
  const runtime = createJobRuntime({
    store,
    handlers: createWorkflowHandlers({ ...workflowContext, inference }),
    workerId: `worker-${randomUUID()}`,
    leaseMs: config.leaseMs,
    operationTimeoutMs: config.operationTimeoutMs,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
  });
  const worker = createJobWorker({
    db,
    store,
    runtime,
    audioObjectStore,
    compatibilityIngress,
    retention,
    ...config,
  });
  installWorkerSignals(worker);
  await worker.start();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(() => {
    console.error("job worker failed to start");
    process.exitCode = 2;
  });
}

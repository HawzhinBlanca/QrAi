import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { issueRealtimeTicket } from "../../server/src/lib/ticket.mjs";
import { createTestDatabase } from "../migrations/lib/postgres.mjs";

const { Client } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const entrypoint = join(repo, "server", "src", "realtime", "main.mjs");
const shutdownModule = pathToFileURL(join(repo, "server", "src", "lib", "shutdown.mjs")).href;
const realtimeSecret = "process-lifecycle-ticket-secret-over-32-bytes";
const realtimeTenant = "tenant-process-lifecycle";
const realtimeOrigin = "https://process.example.org";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let importSequence = 0;

async function loadRuntime() {
  importSequence += 1;
  return import(`${pathToFileURL(entrypoint).href}?process-lifecycle=${importSequence}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startReadyDependency() {
  const server = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ready");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function waitUntil(predicate, { timeoutMs = 4_000, message = "condition was not met" } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(message);
}

function dependencySet() {
  const state = {
    asr: true,
    objectStore: true,
    postgres: true,
    worker: true,
  };
  const calls = {
    dbClose: 0,
    dbReady: 0,
    storeClose: 0,
    storeReady: 0,
  };
  const db = {
    async assertRestrictedRole() {
      calls.dbReady += 1;
      if (!state.postgres) throw new Error("postgresql://role:secret@db.internal/quran learner-1");
    },
    async end() {
      calls.dbClose += 1;
    },
  };
  const audioObjectStore = {
    async assertReady({ signal } = {}) {
      calls.storeReady += 1;
      assert.ok(signal === undefined || signal instanceof AbortSignal);
      if (!state.objectStore) throw new Error("s3://private-bucket/tenant/session/chunk");
    },
    async close() {
      calls.storeClose += 1;
    },
  };
  const fetchImpl = async (url, { signal } = {}) => {
    assert.ok(signal instanceof AbortSignal);
    const dependency = new URL(url).port === "8098" ? "worker" : "asr";
    if (!state[dependency]) throw new Error(`secret ${dependency}.internal learner-1`);
    return { status: 200, body: { cancel: async () => {} } };
  };
  const replayAuthority = {
    claim: async () => "fresh",
    renderMetrics: () => "",
    start: () => {},
    stop: async () => {},
  };
  return {
    state,
    calls,
    db,
    audioObjectStore,
    fetchImpl,
    replayAuthority,
    ticketSecret: realtimeSecret,
    tenantId: realtimeTenant,
    allowedOrigins: [realtimeOrigin],
    allowMissingOrigin: false,
    rateLimitEnabled: true,
    trustedProxyHops: 0,
  };
}

async function withApplication(options, body) {
  const runtime = await loadRuntime();
  const app = runtime.createRealtimeApplication(options);
  try {
    await app.ready();
    return await body(app, runtime);
  } finally {
    await app.close();
  }
}

test("the realtime module is a side-effect-free composition and entrypoint seam", async () => {
  const before = process._getActiveHandles().filter((handle) => handle?.constructor?.name === "Server");
  const runtime = await loadRuntime();
  const after = process._getActiveHandles().filter((handle) => handle?.constructor?.name === "Server");

  assert.deepEqual(Object.keys(runtime).sort(), [
    "createRealtimeApplication",
    "parseRealtimeConfig",
    "startRealtimeProcess",
  ]);
  assert.equal(after.length, before.length, "importing the realtime module bound a server");
});

test("realtime process configuration is strict, bounded, and role-specific", async () => {
  const { parseRealtimeConfig } = await loadRuntime();
  const base = {
    DATABASE_URL: "postgresql://restricted@127.0.0.1/quran_ai",
    NODE_REALTIME_BIND: "127.0.0.1:8081",
    ML_INFERENCE_URL: "http://job-worker:8098",
    ASR_SERVICE_URL: "http://asr-inference:8091",
    REALTIME_READINESS_TIMEOUT_MS: "250",
    SHUTDOWN_GRACE_SECS: "8",
    METRICS_TOKEN: "metrics-token",
    REALTIME_GATEWAY_TICKET_SECRET: realtimeSecret,
    GATEWAY_TENANT_ID: realtimeTenant,
    CORS_ALLOWED_ORIGINS: realtimeOrigin,
  };
  assert.deepEqual(parseRealtimeConfig(base), {
    asrReadyUrl: "http://asr-inference:8091/ready",
    allowedOrigins: [realtimeOrigin],
    allowMissingOrigin: false,
    databaseUrl: base.DATABASE_URL,
    host: "127.0.0.1",
    metricsDevOpen: false,
    metricsToken: "metrics-token",
    port: 8081,
    rateLimitEnabled: true,
    readinessTimeoutMs: 250,
    shutdownGraceMs: 8_000,
    tenantId: realtimeTenant,
    ticketSecret: realtimeSecret,
    trustedProxyHops: 0,
    workerReadyUrl: "http://job-worker:8098/ready",
  });

  for (const [name, env] of [
    ["missing database", { ...base, DATABASE_URL: "" }],
    ["invalid bind", { ...base, NODE_REALTIME_BIND: "localhost" }],
    ["zero port", { ...base, NODE_REALTIME_BIND: "127.0.0.1:0" }],
    ["fractional timeout", { ...base, REALTIME_READINESS_TIMEOUT_MS: "1.5" }],
    ["zero timeout", { ...base, REALTIME_READINESS_TIMEOUT_MS: "0" }],
    ["credentialed worker URL", { ...base, ML_INFERENCE_URL: "http://user:secret@worker:8098" }],
    ["worker URL path", { ...base, ML_INFERENCE_URL: "http://worker:8098/v1" }],
    ["unsupported ASR URL", { ...base, ASR_SERVICE_URL: "file:///tmp/asr" }],
    ["invalid grace", { ...base, SHUTDOWN_GRACE_SECS: "301" }],
    ["missing ticket secret", { ...base, REALTIME_GATEWAY_TICKET_SECRET: "" }],
    ["missing tenant", { ...base, GATEWAY_TENANT_ID: "" }],
    ["invalid Origin", { ...base, CORS_ALLOWED_ORIGINS: `${realtimeOrigin}/path` }],
    ["inert proxy hops", { ...base, TRUST_PROXY_HOPS: "1" }],
  ]) {
    assert.throws(() => parseRealtimeConfig(env), undefined, name);
  }
});

test("the process exposes only health, deep readiness, and private fixed-cardinality metrics", async () => {
  const dependencies = dependencySet();
  await withApplication({
    ...dependencies,
    workerReadyUrl: "http://job-worker:8098/ready",
    asrReadyUrl: "http://asr-inference:8091/ready",
    readinessTimeoutMs: 100,
    metricsToken: "metrics-token",
    metricsDevOpen: false,
    logger: false,
  }, async (app) => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.body, "ok");

    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body, "ready");

    assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 404);
    assert.equal((await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-metrics-token": "wrong" },
    })).statusCode, 404);
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-metrics-token": "metrics-token" },
    });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.headers["content-type"], /text\/plain; version=0\.0\.4/);
    assert.match(metrics.body, /realtime_process_ready 1/);
    for (const dependency of ["postgres", "object_store", "worker", "asr"]) {
      assert.match(
        metrics.body,
        new RegExp(`realtime_readiness_failures_total\\{dependency="${dependency}"\\} 0`),
      );
    }
    assert.doesNotMatch(metrics.body, /tenant|learner|session|chunk|trace|secret|internal/i);

    for (const request of [
      { method: "GET", url: "/" },
      { method: "GET", url: "/v1/recitation-sessions/s1/audio" },
      { method: "POST", url: "/health" },
    ]) {
      assert.equal((await app.inject(request)).statusCode, 404, `${request.method} ${request.url}`);
    }
  });
  assert.equal(dependencies.calls.dbClose, 1);
  assert.equal(dependencies.calls.storeClose, 1);
});

test("each dependency fault degrades readiness without leaking detail or changing liveness", async () => {
  const dependencies = dependencySet();
  await withApplication({
    ...dependencies,
    workerReadyUrl: "http://job-worker:8098/ready",
    asrReadyUrl: "http://asr-inference:8091/ready",
    readinessTimeoutMs: 100,
    metricsToken: null,
    metricsDevOpen: true,
    logger: false,
  }, async (app) => {
    for (const dependency of ["postgres", "objectStore", "worker", "asr"]) {
      dependencies.state[dependency] = false;
      const ready = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(ready.statusCode, 503, dependency);
      assert.equal(ready.body, "not ready", dependency);
      assert.doesNotMatch(ready.body, /postgres|s3|worker|asr|secret|internal|learner/i);
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200, dependency);
      dependencies.state[dependency] = true;
      assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 200);
    }

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(metrics.statusCode, 200);
    for (const dependency of ["postgres", "object_store", "worker", "asr"]) {
      assert.match(
        metrics.body,
        new RegExp(`realtime_readiness_failures_total\\{dependency="${dependency}"\\} 1`),
      );
    }
    assert.doesNotMatch(metrics.body, /db\.internal|private-bucket|learner-1|secret/);
  });
});

test("a dependency that ignores AbortSignal cannot make readiness exceed its outer bound", async () => {
  const dependencies = dependencySet();
  const fetchImpl = async () => new Promise(() => {});
  await withApplication({
    ...dependencies,
    fetchImpl,
    workerReadyUrl: "http://job-worker:8098/ready",
    asrReadyUrl: "http://asr-inference:8091/ready",
    readinessTimeoutMs: 25,
    metricsToken: null,
    metricsDevOpen: true,
    logger: false,
  }, async (app) => {
    const started = performance.now();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 503);
    assert.ok(performance.now() - started < 150, "readiness ignored its outer timeout");
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    assert.match(metrics.body, /dependency="worker"} 1/);
    assert.match(metrics.body, /dependency="asr"} 1/);
  });
});

test("the process owns only the authorized audio upgrade and closes the W3.3 shadow unavailable", async () => {
  const source = readFileSync(entrypoint, "utf8");
  assert.match(source, /@fastify\/websocket/);
  assert.match(source, /websocket:\s*true/);
  assert.doesNotMatch(source, /\.on\(["']upgrade["'], refuseUpgrade\)/);
  const dependencies = dependencySet();
  const runtime = await loadRuntime();
  const app = runtime.createRealtimeApplication({
    ...dependencies,
    workerReadyUrl: "http://job-worker:8098/ready",
    asrReadyUrl: "http://asr-inference:8091/ready",
    readinessTimeoutMs: 100,
    metricsToken: null,
    metricsDevOpen: true,
    logger: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = app.server.address().port;
  try {
    const signedTicket = issueRealtimeTicket({
      sessionId: "s1",
      tenantId: realtimeTenant,
      learnerId: "learner-process",
      externalAsrProcessing: false,
      audioRetention: "discard",
      expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
      nonce: "process-nonce",
    }, realtimeSecret);
    const socket = createConnection({ host: "127.0.0.1", port });
    let reply = Buffer.alloc(0);
    let closeCode = null;
    socket.on("data", (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      const headerEnd = reply.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const frame = reply.subarray(headerEnd + 4);
      if (frame.length >= 4 && (frame[0] & 0x0f) === 0x08) {
        closeCode = frame.readUInt16BE(2);
        // A raw TCP test client does not implement the WebSocket close handshake. Once the server
        // proves its 1013 frame, terminate the test peer so app.close is not held for ws's timeout.
        socket.destroy();
      }
    });
    socket.write(
      `GET /v1/recitation-sessions/s1/audio?ticket=${encodeURIComponent(signedTicket)} HTTP/1.1\r\n` +
      "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Sec-WebSocket-Key: BwcHBwcHBwcHBwcHBwcHBw==\r\nSec-WebSocket-Version: 13\r\n" +
      `Origin: ${realtimeOrigin}\r\n\r\n`,
    );
    await Promise.race([
      new Promise((resolve) => socket.once("close", resolve)),
      sleep(500).then(() => { throw new Error("admitted W3.3 socket remained open"); }),
    ]);
    assert.match(reply.toString("latin1"), /^HTTP\/1\.1 101 Switching Protocols/m);
    assert.equal(closeCode, 1013);
  } finally {
    await app.close();
  }
});

async function spawnApi() {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server/src/main.mjs"], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      ALLOW_INSECURE_SECRETS: "1",
      ALLOW_SUPERUSER_DB_ROLE: "1",
      DISABLE_RATE_LIMIT: "1",
      NODE_API_BIND: `127.0.0.1:${port}`,
      NODE_API_PORTED: "GET /health",
      PLATFORM_API_UPSTREAM: "http://127.0.0.1:1",
      SHUTDOWN_GRACE_SECS: "1",
      AUDIO_STORAGE_DRIVER: "filesystem",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`API failed to start: ${stderr}`);
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
    } catch {
      return false;
    }
  });
  return { child, exit, port, get stderr() { return stderr; } };
}

async function spawnRealtimeFixture() {
  const port = await reservePort();
  const script = `
    import { createRealtimeApplication } from ${JSON.stringify(pathToFileURL(entrypoint).href)};
    import { installProcessShutdown } from ${JSON.stringify(shutdownModule)};
    const db = { assertRestrictedRole: async () => {}, end: async () => {} };
    const audioObjectStore = { assertReady: async () => {}, close: async () => {} };
    const replayAuthority = {
      claim: async () => "fresh",
      renderMetrics: () => "",
      start: () => {},
      stop: async () => {},
    };
    const app = createRealtimeApplication({
      db,
      audioObjectStore,
      replayAuthority,
      workerReadyUrl: "http://worker:8098/ready",
      asrReadyUrl: "http://asr:8091/ready",
      readinessTimeoutMs: 50,
      metricsToken: null,
      metricsDevOpen: true,
      ticketSecret: ${JSON.stringify(realtimeSecret)},
      tenantId: ${JSON.stringify(realtimeTenant)},
      allowedOrigins: [${JSON.stringify(realtimeOrigin)}],
      allowMissingOrigin: false,
      rateLimitEnabled: true,
      trustedProxyHops: 0,
      fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
      logger: false,
    });
    installProcessShutdown(app, { graceMs: 1000, role: "node realtime" });
    await app.listen({ host: "127.0.0.1", port: ${port} });
    console.log("READY");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repo,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await waitUntil(() => stdout.includes("READY"), {
    message: `realtime fixture failed to start: ${stderr}`,
  });
  return { child, exit, port, get stderr() { return stderr; } };
}

test("API and realtime commands survive each other's independent process termination", async (t) => {
  let api = await spawnApi();
  let realtime = await spawnRealtimeFixture();
  t.after(async () => {
    if (api.child.exitCode === null) api.child.kill("SIGKILL");
    if (realtime.child.exitCode === null) realtime.child.kill("SIGKILL");
    await Promise.all([api.exit, realtime.exit]);
  });

  api.child.kill("SIGTERM");
  assert.deepEqual(await api.exit, { code: 0, signal: null }, api.stderr);
  assert.equal((await fetch(`http://127.0.0.1:${realtime.port}/health`)).status, 200);

  api = await spawnApi();
  realtime.child.kill("SIGTERM");
  assert.deepEqual(await realtime.exit, { code: 0, signal: null }, realtime.stderr);
  assert.equal((await fetch(`http://127.0.0.1:${api.port}/health`)).status, 200);
});

test("the real realtime entrypoint boots restricted and exits cleanly on SIGTERM", async (t) => {
  const database = await createTestDatabase(t, "realtime_process");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });
  const roleName = `qrai_realtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "declared-realtime-process-password";
  await provisionApplicationRole({
    connectionString: database.connectionString,
    roleName,
    password,
  });
  const runtimeUrl = new URL(database.connectionString);
  runtimeUrl.username = roleName;
  runtimeUrl.password = password;

  const [worker, asr] = await Promise.all([startReadyDependency(), startReadyDependency()]);
  const port = await reservePort();
  const storageRoot = mkdtempSync(join(tmpdir(), "qrai-realtime-process-"));
  let stderr = "";
  const child = spawn(process.execPath, ["server/src/realtime/main.mjs"], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: runtimeUrl.toString(),
      NODE_REALTIME_BIND: `127.0.0.1:${port}`,
      ML_INFERENCE_URL: worker.url,
      ASR_SERVICE_URL: asr.url,
      REALTIME_READINESS_TIMEOUT_MS: "250",
      SHUTDOWN_GRACE_SECS: "2",
      METRICS_DEV_OPEN: "1",
      REALTIME_GATEWAY_TICKET_SECRET: realtimeSecret,
      GATEWAY_TENANT_ID: realtimeTenant,
      CORS_ALLOWED_ORIGINS: realtimeOrigin,
      AUDIO_STORAGE_DRIVER: "filesystem",
      AUDIO_STORAGE_DIR: storageRoot,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(`realtime exited during startup: ${stderr}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 5_000, message: `realtime readiness timed out: ${stderr}` });

    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /realtime_process_ready 1/);

    child.kill("SIGTERM");
    const result = await Promise.race([
      exit,
      sleep(3_000).then(() => { throw new Error(`realtime did not exit: ${stderr}`); }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.match(stderr, /node realtime shutdown complete/);
    assert.doesNotMatch(stderr, /postgresql:|declared-realtime|qrai_realtime|object_key/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all([exit, worker.close(), asr.close()]);
    rmSync(storageRoot, { recursive: true, force: true });
    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    await admin.query(`drop owned by "${roleName}" cascade`);
    await admin.query(`drop role if exists "${roleName}"`);
    await admin.end();
  }
});

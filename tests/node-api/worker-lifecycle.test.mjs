import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  createJobWorker,
  installWorkerSignals,
  parseWorkerConfig,
} from "../../server/src/worker.mjs";
import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase } from "../migrations/lib/postgres.mjs";

const { Client } = pg;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("worker configuration is strict and enforces the lease/deadline relationship", () => {
  const base = {
    DATABASE_URL: "postgresql://worker.invalid/quran",
    ML_API_KEY: "declared-worker-key",
    METRICS_TOKEN: "declared-metrics-token",
  };
  assert.deepEqual(parseWorkerConfig(base), {
    databaseUrl: base.DATABASE_URL,
    host: "127.0.0.1",
    leaseMs: 65_000,
    metricsDevOpen: false,
    metricsToken: base.METRICS_TOKEN,
    mlApiKey: base.ML_API_KEY,
    operationTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    port: 8098,
    retryBaseMs: 1_000,
    retryMaxMs: 300_000,
    shutdownGraceMs: 8_000,
    trustedRateLimit: 6_000,
  });
  for (const [name, env] of [
    ["missing database", { ...base, DATABASE_URL: "" }],
    ["missing ML key", { ...base, ML_API_KEY: "" }],
    ["missing metrics gate", { ...base, METRICS_TOKEN: "" }],
    ["fractional poll", { ...base, JOB_POLL_INTERVAL_MS: "1.5" }],
    ["invalid trusted compatibility rate", { ...base, ML_TRUSTED_RATE_LIMIT_MAX: "0" }],
    ["lease not greater than operation", {
      ...base,
      JOB_LEASE_SECS: "60",
      JOB_OPERATION_TIMEOUT_SECS: "60",
    }],
    ["out-of-range bind port", { ...base, JOB_WORKER_BIND: "127.0.0.1:70000" }],
  ]) {
    assert.throws(() => parseWorkerConfig(env), undefined, name);
  }
  assert.equal(
    parseWorkerConfig({ ...base, METRICS_TOKEN: "", METRICS_DEV_OPEN: "1" }).metricsDevOpen,
    true,
  );
});

test("worker polls tenants fairly, exposes private bounded metrics, and drains resources", async () => {
  const claims = [];
  let runtimeDrains = 0;
  let dbClosed = 0;
  let storageClosed = 0;
  let storageReady = 0;
  let retentionStarts = 0;
  let retentionStops = 0;
  const closeOrder = [];
  const db = {
    async assertRestrictedRole() {},
    async listTenantIds() { return ["tenant-a", "tenant-b"]; },
    async end() { dbClosed += 1; closeOrder.push("db"); },
  };
  const store = {
    async summary({ tenantId }) {
      return tenantId === "tenant-a"
        ? { queued: 1, running: 0, retry: 2, completed: 9, dead: 0 }
        : { queued: 3, running: 1, retry: 0, completed: 4, dead: 2 };
    },
  };
  const runtime = {
    async runOne(tenantId) {
      claims.push(tenantId);
      return { outcome: claims.length <= 2 ? "completed" : "idle", job: null };
    },
    renderMetrics() {
      return "job_attempts_total{kind=\"privacy.delete\",outcome=\"completed\"} 1\n";
    },
    async drain() { runtimeDrains += 1; closeOrder.push("jobs"); return true; },
  };
  const audioObjectStore = {
    async assertReady() { storageReady += 1; },
    async close() { storageClosed += 1; closeOrder.push("storage"); },
  };
  const retention = {
    async start() { retentionStarts += 1; },
    async stop() { retentionStops += 1; closeOrder.push("retention"); return true; },
  };
  const worker = createJobWorker({
    db,
    store,
    runtime,
    audioObjectStore,
    retention,
    host: "127.0.0.1",
    port: 0,
    pollIntervalMs: 10,
    shutdownGraceMs: 200,
    metricsToken: "declared-metrics-token",
    metricsDevOpen: false,
    log: () => {},
  });
  await worker.start();
  await sleep(35);
  assert.deepEqual(claims.slice(0, 2), ["tenant-a", "tenant-b"]);
  assert.deepEqual(claims.slice(2, 4), ["tenant-b", "tenant-a"], "poll start did not rotate");

  const health = await fetch(`${worker.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");
  const ready = await fetch(`${worker.url}/ready`);
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), "ready");
  assert.ok(storageReady >= 2, "storage readiness was not checked at startup and scrape time");

  assert.equal((await fetch(`${worker.url}/metrics`)).status, 404);
  const metrics = await fetch(`${worker.url}/metrics`, {
    headers: { "x-metrics-token": "declared-metrics-token" },
  });
  assert.equal(metrics.status, 200);
  const body = await metrics.text();
  assert.match(body, /job_state\{status="queued"\} 4/);
  assert.match(body, /job_state\{status="running"\} 1/);
  assert.match(body, /job_state\{status="retry"\} 2/);
  assert.match(body, /job_state\{status="dead"\} 2/);
  for (const forbidden of ["tenant-a", "tenant-b", "learner", "session", "object_key"]) {
    assert.doesNotMatch(body, new RegExp(forbidden));
  }

  await worker.shutdown("test");
  assert.equal(runtimeDrains, 1);
  assert.equal(dbClosed, 1);
  assert.equal(storageClosed, 1);
  assert.equal(retentionStarts, 1);
  assert.equal(retentionStops, 1);
  assert.deepEqual(closeOrder, ["retention", "jobs", "storage", "db"]);
  const after = claims.length;
  await sleep(25);
  assert.equal(claims.length, after, "worker claimed after drain began");
  assert.equal(worker.isDraining, true);
});

test("SIGTERM starts one idempotent worker shutdown", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  let calls = 0;
  const controller = {
    async shutdown(reason) {
      calls += 1;
      assert.equal(reason, "SIGTERM");
    },
  };
  const signals = installWorkerSignals(controller, { processRef, log: () => {} });
  processRef.emit("SIGTERM");
  processRef.emit("SIGTERM");
  await sleep(5);
  assert.equal(calls, 1);
  assert.equal(processRef.exitCode, 0);
  signals.dispose();
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("real worker entrypoint boots restricted, serves readiness, and exits cleanly on SIGTERM", async (t) => {
  const database = await createTestDatabase(t, "worker_process");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });
  const roleName = `qrai_worker_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "declared-worker-process-password";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  const runtimeUrl = new URL(database.connectionString);
  runtimeUrl.username = roleName;
  runtimeUrl.password = password;

  const port = await reservePort();
  const storageRoot = mkdtempSync(join(tmpdir(), "qrai-worker-process-"));
  let stderr = "";
  const child = spawn(process.execPath, ["server/src/worker.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: runtimeUrl.toString(),
      ML_API_KEY: "declared-worker-process-key",
      METRICS_DEV_OPEN: "1",
      JOB_WORKER_BIND: `127.0.0.1:${port}`,
      JOB_POLL_INTERVAL_MS: "10",
      JOB_OPERATION_TIMEOUT_SECS: "1",
      JOB_LEASE_SECS: "2",
      SHUTDOWN_GRACE_SECS: "2",
      AUDIO_STORAGE_DRIVER: "filesystem",
      AUDIO_STORAGE_DIR: storageRoot,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`worker exited during startup: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        if (response.status === 200) break;
      } catch {
        // still starting
      }
      if (Date.now() >= deadline) throw new Error(`worker readiness timed out: ${stderr}`);
      await sleep(20);
    }
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /job_state\{status="dead"\} 0/);

    child.kill("SIGTERM");
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not exit: ${stderr}`)), 3_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.match(stderr, /job worker shutdown complete/);
    assert.doesNotMatch(stderr, /postgresql:|hikmah-pilot|learner|session|object_key/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(storageRoot, { recursive: true, force: true });
    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    await admin.query(`drop owned by "${roleName}" cascade`);
    await admin.query(`drop role if exists "${roleName}"`);
    await admin.end();
  }
});

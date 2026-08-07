import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const entrypoint = join(repo, "server", "src", "main.mjs");
const appModule = pathToFileURL(join(repo, "server", "src", "app.mjs")).href;
const shutdownModule = pathToFileURL(join(repo, "server", "src", "lib", "shutdown.mjs")).href;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
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

async function startUpstream(t, { slowDelayMs = 250 } = {}) {
  let slowStartedResolve;
  let hangStartedResolve;
  let hangClosedResolve;
  const slowStarted = new Promise((resolve) => (slowStartedResolve = resolve));
  const hangStarted = new Promise((resolve) => (hangStartedResolve = resolve));
  const hangClosed = new Promise((resolve) => (hangClosedResolve = resolve));
  let hangCloseCount = 0;

  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      slowStartedResolve();
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("completed-before-grace");
      }, slowDelayMs);
      return;
    }
    if (request.url === "/hang") {
      hangStartedResolve();
      request.socket.once("close", () => {
        hangCloseCount += 1;
        hangClosedResolve();
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    url: `http://127.0.0.1:${port}`,
    slowStarted,
    hangStarted,
    hangClosed,
    get hangCloseCount() {
      return hangCloseCount;
    },
  };
}

async function spawnApi(t, overrides = {}) {
  const { port: requestedPort, ...envOverrides } = overrides;
  const port = requestedPort ?? await freePort();
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      ALLOW_INSECURE_SECRETS: "1",
      ALLOW_SUPERUSER_DB_ROLE: "1",
      DISABLE_RATE_LIMIT: "1",
      NODE_API_BIND: `127.0.0.1:${port}`,
      PLATFORM_API_UPSTREAM: "http://127.0.0.1:1",
      UPSTREAM_TIMEOUT_SECS: "30",
      SHUTDOWN_GRACE_SECS: "2",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });

  t.after(async () => {
    if (!exited) child.kill("SIGKILL");
    await exit;
  });

  return {
    child,
    exit,
    port,
    url: `http://127.0.0.1:${port}`,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function waitForApi(api) {
  await waitUntil(async () => {
    try {
      const response = await fetch(`${api.url}/health`, { signal: AbortSignal.timeout(200) });
      return response.status === 200;
    } catch {
      return false;
    }
  }, {
    timeoutMs: 5_000,
    message: `API did not become ready. stderr:\n${api.stderr}`,
  });
}

async function waitForAdmissionStop(url) {
  return waitUntil(async () => {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(150) });
      return response.status === 503;
    } catch {
      return true;
    }
  }, { timeoutMs: 500, message: "API continued accepting work after SIGTERM" });
}

test("invalid shutdown grace refuses process startup", async (t) => {
  for (const raw of ["0", "1.5", "301"]) {
    await t.test(raw, async (t) => {
      const api = await spawnApi(t, { SHUTDOWN_GRACE_SECS: raw });
      const result = await Promise.race([api.exit, sleep(700).then(() => null)]);
      assert.ok(result, `SHUTDOWN_GRACE_SECS=${raw} was ignored; process kept running`);
      assert.equal(result.code, 2, api.stderr);
      assert.match(api.stderr, /SHUTDOWN_GRACE_SECS/);
    });
  }
});

test("SIGTERM stops admission but preserves an in-flight request that completes in grace", async (t) => {
  const upstream = await startUpstream(t);
  const api = await spawnApi(t, {
    PLATFORM_API_UPSTREAM: upstream.url,
    SHUTDOWN_GRACE_SECS: "2",
  });
  await waitForApi(api);

  const responsePromise = fetch(`${api.url}/slow`).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  await upstream.slowStarted;
  const signalledAt = performance.now();
  api.child.kill("SIGTERM");

  await waitForAdmissionStop(api.url);
  const outcome = await responsePromise;
  assert.equal(outcome.error, undefined, outcome.error?.message);
  const { response } = outcome;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "completed-before-grace");

  const result = await api.exit;
  assert.deepEqual(result, { code: 0, signal: null }, api.stderr);
  assert.ok(performance.now() - signalledAt < 2_000, "process exceeded its configured grace");
  assert.match(api.stderr, /shutdown started.*SIGTERM/);
  assert.match(api.stderr, /shutdown complete/);
  assert.doesNotMatch(api.stderr, /force-closing/);
});

test("a hung request is disconnected at the force phase and the process exits inside grace", async (t) => {
  const upstream = await startUpstream(t);
  const api = await spawnApi(t, {
    PLATFORM_API_UPSTREAM: upstream.url,
    SHUTDOWN_GRACE_SECS: "1",
  });
  await waitForApi(api);

  const request = fetch(`${api.url}/hang`).then(
    async (response) => ({ body: await response.text() }),
    (error) => ({ error }),
  );
  await upstream.hangStarted;
  const signalledAt = performance.now();
  api.child.kill("SIGTERM");

  const outcome = await request;
  assert.ok(outcome.error, `hung request unexpectedly completed: ${outcome.body}`);
  await Promise.race([
    upstream.hangClosed,
    sleep(1_200).then(() => { throw new Error("upstream request was not aborted"); }),
  ]);
  const result = await api.exit;
  assert.deepEqual(result, { code: 0, signal: null }, api.stderr);
  assert.equal(upstream.hangCloseCount, 1);
  assert.ok(performance.now() - signalledAt < 1_100, "forced shutdown exceeded grace");
  assert.match(api.stderr, /force-closing/);
  assert.match(api.stderr, /shutdown complete/);
});

test("a repeated termination signal escalates one in-progress shutdown without duplicate cleanup", async (t) => {
  const upstream = await startUpstream(t);
  const api = await spawnApi(t, {
    PLATFORM_API_UPSTREAM: upstream.url,
    SHUTDOWN_GRACE_SECS: "3",
  });
  await waitForApi(api);

  const request = fetch(`${api.url}/hang`).then(
    async (response) => ({ body: await response.text() }),
    (error) => ({ error }),
  );
  await upstream.hangStarted;
  const signalledAt = performance.now();
  api.child.kill("SIGTERM");
  await sleep(75);
  api.child.kill("SIGTERM");

  const outcome = await request;
  assert.ok(outcome.error, `hung request unexpectedly completed: ${outcome.body}`);
  const result = await api.exit;
  assert.deepEqual(result, { code: 0, signal: null }, api.stderr);
  assert.ok(performance.now() - signalledAt < 1_000, "second signal did not escalate shutdown");
  assert.equal((api.stderr.match(/shutdown started/g) ?? []).length, 1, api.stderr);
  assert.equal((api.stderr.match(/shutdown complete/g) ?? []).length, 1, api.stderr);
});

test("the production controller bounds a held protocol-upgraded socket", async (t) => {
  const port = await freePort();
  const script = `
    import { createApplication } from ${JSON.stringify(appModule)};
    import { installProcessShutdown } from ${JSON.stringify(shutdownModule)};
    const app = createApplication({ logger: false, rateLimitEnabled: false });
    app.server.on("upgrade", (_request, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: qrai-test\\r\\n\\r\\n");
    });
    installProcessShutdown(app, { graceMs: 1000 });
    await app.listen({ host: "127.0.0.1", port: ${port} });
    console.log("READY");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => {
    exited = { code, signal };
    resolve(exited);
  }));
  t.after(async () => {
    if (!exited) child.kill("SIGKILL");
    await exit;
  });
  await waitUntil(() => stdout.includes("READY"), {
    message: `upgrade fixture did not start. stderr:\n${stderr}`,
  });

  const socket = createConnection({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: qrai-test\r\n\r\n");
  let reply = "";
  socket.on("data", (chunk) => (reply += chunk.toString()));
  await waitUntil(() => reply.includes("101 Switching Protocols"));

  const signalledAt = performance.now();
  child.kill("SIGTERM");
  await once(socket, "close");
  const result = await exit;
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.ok(performance.now() - signalledAt < 1_100, "upgrade socket defeated the hard grace");
  assert.match(stderr, /force-closing/);
  assert.match(stderr, /shutdown complete/);
});

test("the hard outer deadline exits non-zero when resource cleanup itself never settles", async (t) => {
  const script = `
    import { EventEmitter } from "node:events";
    import { installProcessShutdown } from ${JSON.stringify(shutdownModule)};
    const server = new EventEmitter();
    server.closeAllConnections = () => {};
    const app = { server, close: () => new Promise(() => {}) };
    installProcessShutdown(app, { graceMs: 200 });
    setInterval(() => {}, 1000);
    console.log("READY");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => {
    exited = { code, signal };
    resolve(exited);
  }));
  t.after(async () => {
    if (!exited) child.kill("SIGKILL");
    await exit;
  });
  await waitUntil(() => stdout.includes("READY"), {
    message: `hard-deadline fixture did not start. stderr:\n${stderr}`,
  });

  const signalledAt = performance.now();
  child.kill("SIGTERM");
  const result = await exit;
  assert.deepEqual(result, { code: 1, signal: null }, stderr);
  assert.ok(performance.now() - signalledAt < 350, "hard shutdown deadline was not enforced");
  assert.match(stderr, /hard deadline exceeded/);
  assert.doesNotMatch(stderr, /shutdown complete/);
});

test("successful shutdown closes the live Postgres pool before completion", async (t) => {
  const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
  const runtimeUrl = process.env.DATABASE_URL ?? adminUrl;
  if (!adminUrl || !runtimeUrl) {
    t.skip("live Postgres URLs are not configured");
    return;
  }

  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("live administrative Postgres is unavailable");
    return;
  }
  t.after(() => admin.end());

  const applicationName = `qrai_shutdown_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const namedRuntimeUrl = new URL(runtimeUrl);
  namedRuntimeUrl.searchParams.set("application_name", applicationName);
  const api = await spawnApi(t, {
    DATABASE_URL: namedRuntimeUrl.toString(),
    PLATFORM_API_UPSTREAM: "",
    SHUTDOWN_GRACE_SECS: "2",
  });
  await waitForApi(api);
  const readiness = await fetch(`${api.url}/ready`);
  assert.equal(readiness.status, 200, await readiness.text());

  const connectionCount = async () => {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return Number(rows[0].count);
  };
  await waitUntil(async () => (await connectionCount()) > 0, {
    message: "the child never opened its identified Postgres pool",
  });

  api.child.kill("SIGTERM");
  const result = await api.exit;
  assert.deepEqual(result, { code: 0, signal: null }, api.stderr);
  assert.match(api.stderr, /resources closed/);
  assert.match(api.stderr, /shutdown complete/);
  assert.ok(
    api.stderr.indexOf("resources closed") < api.stderr.indexOf("shutdown complete"),
    api.stderr,
  );
  await waitUntil(async () => (await connectionCount()) === 0, {
    message: "Postgres pool remained visible after successful shutdown",
  });
});

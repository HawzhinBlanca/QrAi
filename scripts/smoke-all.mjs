import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
await mkdir(artifactRoot, { recursive: true });

const startedServices = [];
const results = [];
const failures = [];

try {
  await runStep("proof", ["pnpm", "proof"]);

  // Clean and re-seed the database between integration tests (which commit invalid/violating rows)
  // and the smoke tests.
  console.log("Cleaning and re-seeding database before smoke tests...");
  await new Promise((resolve) => {
    const parts = (process.env.PSQL || "psql").split(" ");
    const cmd = parts[0];
    const args = [
      ...parts.slice(1),
      "-U", "hawzhin",
      "-d", "quran_ai",
      "-c", "TRUNCATE recitation_sessions, users, institutions, audit_events, consent_records, realtime_session_tickets, audio_chunks, word_alignments, alignment_runs, tajweed_findings, teacher_reviews, scholar_approvals, agent_runs, eval_runs, privacy_jobs CASCADE;"
    ];
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("close", resolve);
  });
  await new Promise((resolve) => {
    const child = spawn("bash", ["packages/quran-data/scripts/seed-full-quran-to-db.sh"], {
      env: {
        ...process.env,
        PGPASSWORD: "change-this-to-a-strong-password",
        PSQL: process.env.PSQL || "psql"
      },
      stdio: "ignore"
    });
    child.on("close", resolve);
  });
  await new Promise((resolve) => {
    const parts = (process.env.PSQL || "psql").split(" ");
    const cmd = parts[0];
    const args = [
      ...parts.slice(1),
      "-U", "hawzhin",
      "-d", "quran_ai",
      "-f", "infra/sql/0006_seed_internal.sql"
    ];
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("close", resolve);
  });

  await runStep("smoke:sql", ["pnpm", "smoke:sql"]);
  await runStep("smoke:browser", ["pnpm", "smoke:browser"], { SMOKE_ARTIFACT_DIR: artifactRoot });

  // Privacy delete erases the learner's audio from ml-inference BEFORE the DB transaction (fail-closed
  // right-to-erasure), so smoke:api's privacy-delete step needs ml-inference reachable — otherwise it
  // returns 502. Start ml-inference first and point platform-api at it.
  const mlInference = await mlInferenceServiceConfig();
  const mlUp = await ensureHttpService(mlInference);

  const platformApi = await platformApiServiceConfig(mlUp ? mlInference.baseUrl : undefined);
  if (await ensureHttpService(platformApi)) {
    await runStep("smoke:api", ["pnpm", "smoke:api"], platformApi.smokeEnv);
  }

  const realtimeGateway = await realtimeGatewayServiceConfig();
  if (await ensureHttpService(realtimeGateway)) {
    await runStep("smoke:gateway", ["pnpm", "smoke:gateway"], realtimeGateway.smokeEnv);
  }

  await runStep("smoke:ml", ["pnpm", "smoke:ml"], { SMOKE_ARTIFACT_DIR: artifactRoot });
  await runStep("smoke:privacy", ["pnpm", "smoke:privacy"], { SMOKE_ARTIFACT_DIR: artifactRoot });

  const status = failures.length === 0 ? "passed" : "failed";
  await writeSummary(status);
  console.log(JSON.stringify({ status, artifactRoot, traceId: smokeTraceId, results, failures }));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  await writeSummary("failed", error);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const service of startedServices.reverse()) {
    service.kill("SIGTERM");
  }
}

async function ensureHttpService({ name, healthUrl, command, serviceEnv = {} }) {
  if (await isHealthy(healthUrl)) {
    results.push({ step: name, status: "already-running", healthUrl });
    return true;
  }

  const logPath = join(artifactRoot, `${name}.log`);
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, ...serviceEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  startedServices.push(child);

  try {
    await waitForHealth(healthUrl, name);
    results.push({ step: name, status: "started", healthUrl });
  } catch (error) {
    failures.push({ step: name, error: error.message });
    results.push({ step: name, status: "failed", healthUrl });
    return false;
  }

  child.once("exit", async () => {
    await writeFile(logPath, logs.join(""));
  });

  return true;
}

async function platformApiServiceConfig(mlInferenceUrl) {
  if (process.env.PLATFORM_API_SMOKE_URL || process.env.PLATFORM_API_HEALTH_URL) {
    const baseUrl = process.env.PLATFORM_API_SMOKE_URL ?? "http://127.0.0.1:8080";
    return {
      name: "platform-api",
      healthUrl: process.env.PLATFORM_API_HEALTH_URL ?? `${baseUrl}/health`,
      command: ["pnpm", "api:dev"],
      smokeEnv: { PLATFORM_API_SMOKE_URL: baseUrl },
    };
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serviceEnv = { PLATFORM_API_BIND: `127.0.0.1:${port}`, ML_API_KEY: "smoke-ml-api-key" };
  // Point platform-api at the ml-inference started above so the privacy-delete audio erasure resolves.
  if (mlInferenceUrl) serviceEnv.ML_INFERENCE_URL = mlInferenceUrl;
  return {
    name: "platform-api",
    healthUrl: `${baseUrl}/health`,
    command: ["pnpm", "api:dev"],
    serviceEnv,
    smokeEnv: { PLATFORM_API_SMOKE_URL: baseUrl },
  };
}

async function mlInferenceServiceConfig() {
  if (process.env.ML_INFERENCE_URL) {
    const baseUrl = process.env.ML_INFERENCE_URL;
    return { name: "ml-inference", healthUrl: `${baseUrl}/health`, baseUrl, command: ["true"], serviceEnv: {} };
  }
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    name: "ml-inference",
    healthUrl: `${baseUrl}/health`,
    baseUrl,
    command: [process.execPath, "services/ml-inference/server.mjs"],
    // Match platform-api's ML_API_KEY so the server-side proxy key check passes.
    serviceEnv: { ML_INFERENCE_PORT: String(port), ML_API_KEY: "smoke-ml-api-key" },
  };
}

async function realtimeGatewayServiceConfig() {
  if (process.env.REALTIME_GATEWAY_SMOKE_URL || process.env.REALTIME_GATEWAY_HEALTH_URL) {
    const baseUrl = process.env.REALTIME_GATEWAY_BASE_URL ?? "ws://127.0.0.1:8081";
    return {
      name: "realtime-gateway",
      healthUrl: process.env.REALTIME_GATEWAY_HEALTH_URL ?? "http://127.0.0.1:8081/health",
      command: ["pnpm", "gateway:dev"],
      smokeEnv: {
        REALTIME_GATEWAY_BASE_URL: baseUrl,
        REALTIME_GATEWAY_SMOKE_URL: process.env.REALTIME_GATEWAY_SMOKE_URL,
        REALTIME_GATEWAY_TICKET_SECRET: process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret",
      },
    };
  }

  const port = await getFreePort();
  return {
    name: "realtime-gateway",
    healthUrl: `http://127.0.0.1:${port}/health`,
    command: ["pnpm", "gateway:dev"],
    serviceEnv: {
      REALTIME_GATEWAY_BIND: `127.0.0.1:${port}`,
      REALTIME_GATEWAY_TICKET_SECRET: "smoke-secret",
      // The gateway binds to exactly one tenant (GATEWAY_TENANT_ID) and rejects a ticket whose
      // tenant_id doesn't match (services/realtime-gateway/src/lib.rs). smoke-gateway.mjs issues its
      // ticket for `tenant-smoke`, so the gateway must serve that tenant — otherwise the valid-ticket
      // WebSocket is rejected (non-101) even though everything else is correct.
      GATEWAY_TENANT_ID: "tenant-smoke",
    },
    smokeEnv: {
      REALTIME_GATEWAY_BASE_URL: `ws://127.0.0.1:${port}`,
      REALTIME_GATEWAY_TICKET_SECRET: "smoke-secret",
    },
  };
}

async function runStep(name, command, env = {}) {
  const startedAt = Date.now();
  const logPath = join(artifactRoot, `${name.replace(/:/g, "-")}.log`);
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
      env: { ...process.env, SMOKE_TRACE_ID: smokeTraceId, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const code = await new Promise((resolve) => child.on("close", resolve));
  await writeFile(logPath, logs.join(""));
  results.push({
    step: name,
    status: code === 0 ? "passed" : "failed",
    exitCode: code,
    durationMs: Date.now() - startedAt,
    logPath,
  });

  if (code !== 0) {
    failures.push({ step: name, exitCode: code, logPath });
  }
}

async function isHealthy(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

async function writeSummary(status, error) {
  await writeFile(
    join(artifactRoot, "summary.json"),
    JSON.stringify(
      {
        status,
        artifactRoot,
        traceId: smokeTraceId,
        results,
        failures,
        error: error?.message,
      },
      null,
      2,
    ),
  );
}

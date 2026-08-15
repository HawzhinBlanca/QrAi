import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createCompatibilityIngress } from "../../../server/src/inference/compatibility-ingress.mjs";
import { createInferenceRuntime } from "../../../server/src/inference/local.mjs";
import { createAudioObjectStoreFromEnv } from "../../../server/src/storage/audio-object-store.mjs";

function positiveWhole(value, fallback, name) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function json(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export async function startWorkerCompatibilityHarness({
  env = process.env,
  inference = null,
  audioObjectStore = null,
  log = () => {},
} = {}) {
  const store = audioObjectStore ?? createAudioObjectStoreFromEnv({ env });
  await store.assertReady();
  const compatibilityIngress = createCompatibilityIngress({
    audioObjectStore: store,
    inference: inference ?? createInferenceRuntime({ audioObjectStore: store }),
    mlApiKey: env.ML_API_KEY,
    operationTimeoutMs: positiveWhole(
      Number(env.UPSTREAM_TIMEOUT_SECS ?? 60) * 1_000,
      60_000,
      "UPSTREAM_TIMEOUT_SECS",
    ),
    anonymousRateLimit: 100,
    trustedRateLimit: positiveWhole(env.ML_TRUSTED_RATE_LIMIT_MAX, 6_000, "ML_TRUSTED_RATE_LIMIT_MAX"),
    log,
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && (path === "/health" || path === "/ready")) {
      json(response, 200, { status: "ok", service: "job-worker-compatibility" });
      return;
    }
    if (await compatibilityIngress(request, response)) return;
    json(response, 404, { error: "not found" });
  });
  const host = env.ML_INFERENCE_HOST?.trim() || "127.0.0.1";
  const port = positiveWhole(env.ML_INFERENCE_PORT, 8098, "ML_INFERENCE_PORT");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let stopped = false;
  return {
    server,
    url: `http://${host}:${port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  : false;

if (isMain) {
  const harness = await startWorkerCompatibilityHarness({
    log: (message) => process.stderr.write(`${message}\n`),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await harness.stop();
      process.exit(0);
    });
  }
}

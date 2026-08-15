import { createServer } from "node:http";

function text(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

export async function startWorkerCompatibilitySmoke({
  port,
  mlApiKey,
  envOverrides = {},
  log = () => {},
}) {
  const nextEnv = {
    ...envOverrides,
    ML_API_KEY: mlApiKey,
    ML_INFERENCE_HOST: "127.0.0.1",
    ML_INFERENCE_PORT: String(port),
  };
  const priorEnv = Object.fromEntries(Object.keys(nextEnv).map((name) => [name, process.env[name]]));
  Object.assign(process.env, nextEnv);

  const [compatibilityModule, inferenceModule, storageModule] = await Promise.all([
    import("../../server/src/inference/compatibility-ingress.mjs"),
    import("../../server/src/inference/local.mjs"),
    import("../../server/src/storage/audio-object-store.mjs"),
  ]);
  const audioObjectStore = storageModule.createAudioObjectStoreFromEnv();
  await audioObjectStore.assertReady();
  const compatibilityIngress = compatibilityModule.createCompatibilityIngress({
    audioObjectStore,
    inference: inferenceModule.createInferenceRuntime({ audioObjectStore }),
    mlApiKey,
    operationTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_SECS ?? 60) * 1_000,
    log,
  });
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      text(response, 200, "ok");
      return;
    }
    if (await compatibilityIngress(request, response)) return;
    text(response, 404, "not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => server.close(resolve));
      await audioObjectStore.close();
      for (const [name, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

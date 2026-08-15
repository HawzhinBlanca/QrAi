import { createServer } from "node:http";

import { createCompatibilityIngress } from "../../../server/src/inference/compatibility-ingress.mjs";
import { createFilesystemAudioObjectStore } from "../../../server/src/storage/audio-object-store.mjs";

export async function startWorkerCompatibilityIngress({ storageDir, mlApiKey }) {
  const audioObjectStore = createFilesystemAudioObjectStore({ rootDir: storageDir });
  const ingress = createCompatibilityIngress({
    audioObjectStore,
    inference: {
      async predictAlignment() { throw new Error("gateway must not request alignment"); },
      async predictTajweed() { throw new Error("gateway must not request Tajweed"); },
      async transcribeSession() { throw new Error("gateway must not request transcripts"); },
    },
    mlApiKey,
    operationTimeoutMs: 5_000,
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      if (await ingress(request, response)) return;
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not found" }));
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      response.end(JSON.stringify({ error: "internal error" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("worker ingress did not bind TCP");

  return {
    audioObjectStore,
    url: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await audioObjectStore.close();
    },
  };
}

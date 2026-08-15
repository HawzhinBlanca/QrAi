import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { issueRealtimeTicket, newNonce } from "../../server/src/lib/ticket.mjs";
import { parseCompleteStoredMetadata } from "../e2e/lib/stored-metadata.mjs";
import { startWorkerCompatibilityIngress } from "./lib/worker-ingress-harness.mjs";

/**
 * Blocker 3 — the learner's retention choice reaches the stored recording.
 *
 * ── What this proves that the unit tests do not ────────────────────────────────────────────────
 * shared-ticket proves the field survives sign/validate. The gateway's `chunk_forward_body` tests
 * prove the field is in the body it builds. Neither proves the two are the same field, that the
 * gateway forwards what it validated, or that the worker ingress writes it where its retention sweep will
 * read it back. Four correct components can still be wired into a pipeline that drops the value —
 * which is exactly what was shipped: every piece worked, `audioRetention` was simply never put in
 * the body, and the storage default filled the hole so quietly that a learner who chose
 * "teacher-review" had their recitation deleted an hour later with nothing logged.
 *
 * So this test asserts on the ARTIFACT: a real gateway, the worker ingress, a real websocket, and
 * the `.meta.json` actually on disk afterwards. `audioRetention` in that file is what the eviction
 * sweep (server.mjs, `retention = meta.audioRetention ?? "discard"`) consults to decide whether a
 * child's recorded voice is deleted in an hour, in a week, or kept.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const GATEWAY_BIN = join(root, "services/realtime-gateway/target/debug/quran-ai-realtime-gateway");

const SECRET = "audio-retention-e2e-secret-that-is-long-enough";
const TENANT = "tenant-retention-e2e";
const LEARNER = "learner-retention-e2e";
const ML_KEY = "retention-e2e-ml-key";

let gateway;
let workerIngress;
let gatewayPort;
let storageDir;
let stderr = "";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Poll rather than sleep: a fixed sleep is how a suite like this turns flaky and then gets muted. */
async function waitForHealth(url, what) {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what} never became healthy (${url})${stderr ? `\n${stderr}` : ""}`);
}

before(async () => {
  // FAIL, never skip. A suite whose assertions vanish when a binary is missing prints green while
  // guarding nothing.
  assert.ok(
    existsSync(GATEWAY_BIN),
    `${GATEWAY_BIN} is missing — build it first (verify.sh does this before running this file)`,
  );

  // A fresh directory per run, so a stale chunk from an earlier run can never be mistaken for this
  // run's evidence — the failure mode that made a chaos drill report 0/12 against a dead process.
  storageDir = mkdtempSync(join(tmpdir(), "qrai-retention-e2e-"));

  gatewayPort = await freePort();

  workerIngress = await startWorkerCompatibilityIngress({
    storageDir,
    mlApiKey: ML_KEY,
  });
  await waitForHealth(`${workerIngress.url}/health`, "worker compatibility ingress");

  gateway = spawn(GATEWAY_BIN, [], {
    cwd: root,
    env: {
      ...process.env,
      REALTIME_GATEWAY_BIND: `127.0.0.1:${gatewayPort}`,
      REALTIME_GATEWAY_TICKET_SECRET: SECRET,
      GATEWAY_TENANT_ID: TENANT,
      ML_INFERENCE_URL: workerIngress.url,
      ML_API_KEY: ML_KEY,
      // See tests/gateway/ws-hostile-input.test.mjs: CI exports ALLOW_INSECURE_DEFAULTS=1 job-wide
      // and the gateway PANICS when that alias is combined with a per-control variable. Empty
      // rather than deleted, because `enforce_legacy_alias` reads empty as unset and a reader can
      // see an explicit "" in a way they cannot see a missing key.
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
      GATEWAY_ALLOW_MISSING_ORIGIN: "1",
      DISABLE_RATE_LIMIT: "1",
      RUST_BACKTRACE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  gateway.stderr.on("data", (d) => {
    stderr += `[gateway] ${d}`;
  });
  await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`, "realtime-gateway");
});

after(async () => {
  gateway?.kill("SIGKILL");
  await workerIngress?.stop();
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

/** Stream one chunk through a real websocket and wait for the gateway's ack. */
function streamOneChunk(sessionId, ticket) {
  return new Promise((resolve, reject) => {
    const url =
      `ws://127.0.0.1:${gatewayPort}/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio` +
      `?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out streaming to ${sessionId}${stderr ? `\n${stderr}` : ""}`));
    }, 10_000);

    socket.addEventListener("open", () => socket.send(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const ack = JSON.parse(String(event.data));
      socket.close();
      resolve(ack);
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`websocket failed: ${event.message || event.type}`));
    });
  });
}

/** The chunk metadata the worker ingress actually wrote, once it appears. */
async function storedMeta(sessionId) {
  const dir = join(storageDir, "audio", "v1", TENANT, LEARNER, sessionId);
  // The gateway forwards on a spawned task, so the ack can arrive before the POST completes.
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(dir)) {
      const metas = readdirSync(dir).filter((file) => file.endsWith(".pcm.meta.json"));
      if (metas.length > 0) {
        const parsed = parseCompleteStoredMetadata(
          readFileSync(join(dir, metas[0]), "utf8"),
        );
        if (parsed !== null) return parsed;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no chunk metadata for ${sessionId} appeared under ${dir}${stderr ? `\n${stderr}` : ""}`);
}

for (const retention of ["discard", "teacher-review", "training-opt-in"]) {
  test(`a session consented to '${retention}' stores audio labelled '${retention}'`, async () => {
    const sessionId = `session-${retention}`;
    const ticket = issueRealtimeTicket(
      {
        sessionId,
        tenantId: TENANT,
        learnerId: LEARNER,
        externalAsrProcessing: false,
        audioRetention: retention,
        expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
        nonce: newNonce(),
      },
      SECRET,
    );

    const ack = await streamOneChunk(sessionId, ticket);
    assert.equal(ack.accepted, true, `the gateway refused the chunk: ${JSON.stringify(ack)}`);

    const meta = await storedMeta(sessionId);
    assert.equal(
      meta.audioRetention,
      retention,
      "this is the field the eviction sweep reads to decide when a learner's recording is deleted",
    );
  });
}

/**
 * "Fail the chunk, never lose the audio" — proven through the real path, not the counter.
 *
 *   node --test tests/gateway/index-failure-e2e.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * Two unit tests already cover `chunks_index_failed`. Both call `record_index_failure()` directly,
 * so they prove the counter counts — not that a real indexing failure reaches it. Measured: deleting
 * the `forward_gateway.record_index_failure()` call from the production path (lib.rs, the `if
 * !indexed` branch) leaves the gateway suite **47 passed, 0 failed**.
 *
 * That gap matters more than it looks. The whole reason the audio is NOT deleted when indexing fails
 * is that an operator can go and re-index it — which requires knowing it happened. A counter that
 * silently stops incrementing turns "recoverable" into "lost", and every test stays green.
 *
 * So this drives a real WebSocket session against a real ml-inference (the audio genuinely lands on
 * disk) with `PLATFORM_API_URL` pointed at a server that answers 500 to every index call, and then
 * asserts BOTH halves of the promise:
 *
 *   fail the chunk       -> realtime_gateway_chunks_index_failed_total incremented
 *   never lose the audio -> the stored chunk and its metadata are still on disk
 *
 * The second assertion is the one that would catch a "fix" that treated an unindexable chunk as
 * garbage and cleaned it up.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { issueRealtimeTicket, newNonce } from "../../services/node-api/lib/ticket.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const GATEWAY_BIN = join(root, "services/realtime-gateway/target/debug/quran-ai-realtime-gateway");
const ML_ENTRY = join(root, "services/ml-inference/server.mjs");

const SECRET = "index-failure-e2e-secret-that-is-long-enough";
const TENANT = "tenant-index-failure-e2e";
const LEARNER = "learner-index-failure-e2e";
const ML_KEY = "index-failure-e2e-ml-key";
// /metrics is token-gated unless ALLOW_INSECURE_DEFAULTS opens it, and this test keeps that
// closed. Scraping WITH the token is the faithful path anyway: it is how an operator reads
// this counter in production, and an unauthenticated scrape silently returned no body at all
// the first time this ran — the counter read -1 and looked like the finding.
const METRICS_TOKEN = "index-failure-e2e-metrics-token";

let gateway;
let ml;
let platformStub;
let gatewayPort;
let storageDir;
let indexCalls = 0;
let stderr = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

async function waitForHealth(url, what) {
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(50);
  }
  throw new Error(`${what} never became healthy at ${url}${stderr ? `\n${stderr}` : ""}`);
}

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "index-failure-e2e-"));
  const mlPort = await freePort();
  const stubPort = await freePort();
  gatewayPort = await freePort();

  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  ml.stderr.on("data", (d) => {
    stderr += `[ml] ${d}`;
  });
  await waitForHealth(`http://127.0.0.1:${mlPort}/health`, "ml-inference");

  // A platform-api that is UP and refuses. Not a closed port: a refused connection and a 500 take
  // different branches in the gateway's retry loop, and the 500 is the one a real outage looks like
  // — the service is reachable and cannot serve.
  platformStub = createHttpServer((req, res) => {
    indexCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "index unavailable" }));
  });
  await new Promise((r) => platformStub.listen(stubPort, "127.0.0.1", r));

  gateway = spawn(GATEWAY_BIN, [], {
    cwd: root,
    env: {
      ...process.env,
      REALTIME_GATEWAY_BIND: `127.0.0.1:${gatewayPort}`,
      REALTIME_GATEWAY_TICKET_SECRET: SECRET,
      GATEWAY_TENANT_ID: TENANT,
      ML_INFERENCE_URL: `http://127.0.0.1:${mlPort}`,
      ML_API_KEY: ML_KEY,
      PLATFORM_API_URL: `http://127.0.0.1:${stubPort}`,
      METRICS_TOKEN,
      // See tests/gateway/ws-hostile-input.test.mjs: CI exports ALLOW_INSECURE_DEFAULTS=1 job-wide
      // and the gateway PANICS when that alias is combined with a per-control variable.
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
  ml?.kill("SIGKILL");
  await new Promise((r) => platformStub?.close(r) ?? r());
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });
});

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

/** The /metrics body, read the way an operator reads it. */
async function scrapeMetrics() {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
    headers: { "x-metrics-token": METRICS_TOKEN },
  });
  assert.equal(res.status, 200, `/metrics refused the scrape: ${res.status}`);
  return res.text();
}

/** Scrape the counter, retrying while the gateway's spawned task works through its retries. */
async function indexFailuresReported() {
  for (let i = 0; i < 100; i += 1) {
    const res = await scrapeMetrics();
    const m = /realtime_gateway_chunks_index_failed_total (\d+)/.exec(res);
    if (m && Number(m[1]) > 0) return Number(m[1]);
    await sleep(100);
  }
  return Number(/realtime_gateway_chunks_index_failed_total (\d+)/.exec(await scrapeMetrics())?.[1] ?? -1);
}

test("an index failure is REPORTED, and the audio it could not index is still there", async () => {
  const sessionId = "session-index-failure";
  const ticket = issueRealtimeTicket(
    {
      sessionId,
      tenantId: TENANT,
      learnerId: LEARNER,
      externalAsrProcessing: false,
      // `teacher-review`, so nothing is entitled to delete this recording during the test. If the
      // audio vanished under `discard` the retention sweep would be a plausible culprit and the
      // assertion below would be ambiguous.
      audioRetention: "teacher-review",
      expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
      nonce: newNonce(),
    },
    SECRET,
  );

  const ack = await streamOneChunk(sessionId, ticket);
  assert.equal(ack.accepted, true, `the gateway refused the chunk: ${JSON.stringify(ack)}`);

  // ── fail the chunk ──────────────────────────────────────────────────────────────────────────────
  const failures = await indexFailuresReported();
  assert.ok(
    failures > 0,
    `realtime_gateway_chunks_index_failed_total is ${failures} after an index call that answered ` +
      `500 ${indexCalls} time(s). An operator watching this dashboard would see a healthy gateway ` +
      `while recordings became unfindable.${stderr ? `\n${stderr}` : ""}`,
  );

  // The stub really was called — otherwise a gateway that never attempted to index would satisfy
  // the assertion above for the wrong reason if the counter were incremented anywhere else.
  assert.ok(indexCalls > 0, "the gateway never attempted to index the chunk at all");

  // ── never lose the audio ────────────────────────────────────────────────────────────────────────
  const dir = join(storageDir, TENANT, LEARNER);
  assert.ok(existsSync(dir), `no storage directory for the session at all: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.startsWith(sessionId));
  assert.ok(
    files.some((f) => f.endsWith(".meta.json")),
    `the chunk metadata is gone after an index failure — found ${JSON.stringify(files)}. The audio ` +
      `is kept precisely so it can be re-indexed later; deleting it turns a recoverable failure ` +
      `into a lost recitation.`,
  );
  assert.ok(
    files.some((f) => !f.endsWith(".meta.json")),
    `the audio payload is gone after an index failure — found ${JSON.stringify(files)}`,
  );
});

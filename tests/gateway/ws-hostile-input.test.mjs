import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { issueRealtimeTicket, newNonce } from "../../services/node-api/lib/ticket.mjs";

/**
 * G3 — the committed hostile-input sweep of the realtime gateway's WebSocket surface.
 * specs/gateway-ws-sweep/plan.md §4
 *
 * ── Why this spawns a real process ─────────────────────────────────────────────────────────────
 * Every other gateway test drives the router in-process via `tower::ServiceExt::oneshot`, which
 * NEVER performs a WebSocket upgrade — `audio_ws`'s own doc comment says so. So before this file,
 * nothing exercised the transport layer at all, which is exactly how a 16 MiB transport limit sat
 * unnoticed beneath a 2 MiB application limit.
 *
 * ── What it is and is not ──────────────────────────────────────────────────────────────────────
 * The sweep found NO vulnerability (research.md §2). Its value is as a regression net: nothing else
 * asserts that a 100 000-character ticket is rejected, that a text frame is ignored, or that the
 * gateway survives any of it. The liveness assertion at the end is the load-bearing one — a
 * per-case assertion cannot catch a process that died on case 3.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const BIN = join(root, "services/realtime-gateway/target/debug/quran-ai-realtime-gateway");

const SECRET = "gateway-ws-sweep-secret-that-is-long-enough";
const TENANT = "tenant-ws-sweep";
const SESSION = "session-ws-sweep";
const LEARNER = "learner-ws-sweep";
const NUL = String.fromCharCode(0);

/** Mirrors MAX_CHUNK_BYTES and MAX_WS_FRAME_BYTES in services/realtime-gateway/src/lib.rs. */
const APP_LIMIT = 2 * 1024 * 1024;
const TRANSPORT_LIMIT = APP_LIMIT + 64 * 1024;

let child;
let port;
let stderr = "";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: p } = server.address();
      server.close(() => resolve(p));
    });
  });

before(async () => {
  // FAIL, never skip. A suite whose assertions vanish when a binary is missing prints green while
  // guarding nothing — the anti-pattern MIG5 rejected in as many words.
  assert.ok(
    existsSync(BIN),
    `${BIN} is missing — build it first (verify.sh does this explicitly before running this file)`,
  );

  port = await freePort();
  child = spawn(BIN, [], {
    cwd: root,
    env: {
      ...process.env,
      REALTIME_GATEWAY_BIND: `127.0.0.1:${port}`,
      REALTIME_GATEWAY_TICKET_SECRET: SECRET,
      GATEWAY_TENANT_ID: TENANT,
      // MUST be cleared, and CI is where this was learned. `.github/workflows/ci.yml` exports
      // ALLOW_INSECURE_DEFAULTS=1 for the whole job; this spawn inherits process.env, and
      // `enforce_legacy_alias` (specs/insecure-defaults-split/) PANICS when the deprecated alias is
      // set alongside any per-control variable — deliberately, because there is no defensible way to
      // combine them. So the gateway refused to boot and all seven tests failed with "never became
      // healthy". The guard doing exactly its job, on the first configuration that ever hit it.
      //
      // Empty, not deleted: `enforce_legacy_alias` treats an empty value as unset, and an explicit
      // empty string is visible to a reader in a way that a missing key is not.
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
      GATEWAY_ALLOW_MISSING_ORIGIN: "1",
      DISABLE_RATE_LIMIT: "1",
      ML_API_KEY: "ws-sweep-ml-key",
      RUST_BACKTRACE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  // Poll /health rather than sleeping — a fixed sleep is how a suite like this becomes flaky and
  // then gets muted, which would put this surface back to unasserted.
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("the gateway never became healthy");
});

after(() => {
  child?.kill("SIGKILL");
});

const validTicket = (over = {}) =>
  issueRealtimeTicket(
    {
      sessionId: SESSION,
      tenantId: TENANT,
      learnerId: LEARNER,
      externalAsrProcessing: false,
      expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 300,
      nonce: newNonce(),
      ...over,
    },
    SECRET,
  );

/** Open a socket, optionally send one payload, and report what happened. */
function connect(ticket, { payload, waitMs = 600, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const url =
      `ws://127.0.0.1:${port}/v1/recitation-sessions/${SESSION}/audio` +
      `?ticket=${encodeURIComponent(ticket)}`;
    const out = { opened: false, acks: [], close: null };
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return resolve(out); // a URL the client itself refuses counts as not-opened
    }
    ws.binaryType = "arraybuffer";
    const finish = () => resolve(out);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      finish();
    }, timeoutMs);
    ws.onopen = () => {
      out.opened = true;
      if (payload === undefined) {
        ws.close();
        return;
      }
      ws.send(payload);
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      }, waitMs);
    };
    ws.onmessage = (event) => {
      try {
        out.acks.push(JSON.parse(event.data));
      } catch {
        out.acks.push({ raw: String(event.data).slice(0, 80) });
      }
    };
    ws.onerror = () => {};
    ws.onclose = (event) => {
      clearTimeout(timer);
      out.close = event.code;
      finish();
    };
  });
}

// ── the ticket surface, before any upgrade ─────────────────────────────────────────────────────

test("a malformed ticket never reaches the upgrade", async () => {
  const now = Math.floor(Date.now() / 1000);
  const signed = "0".repeat(64);
  const cases = [
    ["empty", ""],
    ["wrong prefix", "hello"],
    ["too few parts", "rt_v1.a.b"],
    ["too many parts", `${validTicket()}.extra.parts`],
    ["100 000 characters", `rt_v1.${"x".repeat(100_000)}`],
    ["a NUL byte", `rt_v1.a.b.c.true.1.n.${NUL}`],
    ["negative expiry", `rt_v1.${SESSION}.${TENANT}.${LEARNER}.false.-1.n.${signed}`],
    ["non-numeric expiry", `rt_v1.${SESSION}.${TENANT}.${LEARNER}.false.abc.n.${signed}`],
    ["non-boolean consent", `rt_v1.${SESSION}.${TENANT}.${LEARNER}.maybe.${now + 300}.n.${signed}`],
    ["short signature", `rt_v1.${SESSION}.${TENANT}.${LEARNER}.false.${now + 300}.n.ab`],
    ["non-hex signature", `rt_v1.${SESSION}.${TENANT}.${LEARNER}.false.${now + 300}.n.${"z".repeat(64)}`],
    // Validly SIGNED but for another session/tenant — the interesting half, because the signature
    // passes and only the binding check refuses it.
    ["another tenant", validTicket({ tenantId: "tenant-somebody-else" })],
    ["another session", validTicket({ sessionId: "session-somebody-else" })],
  ];
  const opened = [];
  for (const [label, ticket] of cases) {
    const res = await connect(ticket, { timeoutMs: 4000 });
    if (res.opened) opened.push(label);
  }
  assert.deepEqual(opened, [], `these upgraded on a ticket that should have been refused:\n  ${opened.join("\n  ")}`);
});

test("a ticket with an implausible lifetime is refused (G2)", async () => {
  // Not an auth bypass — producing this needs the signing secret. The reason it must be refused is
  // that `consumed_tickets` never evicts an entry whose expiry has not passed, so a far-future
  // ticket is a PERMANENT map entry. The boundary itself is pinned in the Rust unit test; this
  // asserts the refusal reaches the wire.
  const res = await connect(validTicket({ expiresAtUnixSeconds: 18446744073709551615n }), {
    timeoutMs: 4000,
  });
  assert.equal(res.opened, false, "a u64::MAX expiry must not upgrade");
});

test("a well-formed ticket connects, so the rejections above mean something", async () => {
  // Without this the whole file could pass against a gateway that refuses everything.
  const res = await connect(validTicket());
  assert.equal(res.opened, true, "a valid ticket must still upgrade");
});

// ── the frame surface, after a successful upgrade ──────────────────────────────────────────────

test("frame sizes: the transport stops absurd frames, the application answers near misses", async () => {
  // The distinction is the point of the +64 KiB slack. An exact transport cap would replace the
  // precise `audio chunk too large` ack with an abrupt close for a frame one byte over the limit.
  const cases = [
    ["1 byte", 1, "accepted"],
    ["exactly the app limit", APP_LIMIT, "accepted"],
    ["app limit + 1", APP_LIMIT + 1, "app-rejected"],
    ["exactly the transport limit", TRANSPORT_LIMIT, "app-rejected"],
    ["past the transport limit", TRANSPORT_LIMIT + 1024, "transport-closed"],
    ["8 MiB", 8 * 1024 * 1024, "transport-closed"],
  ];
  for (const [label, size, expected] of cases) {
    const res = await connect(validTicket(), { payload: new Uint8Array(size), waitMs: 900, timeoutMs: 12_000 });
    assert.equal(res.opened, true, `${label}: should have upgraded`);
    const ack = res.acks[0];
    const actual = !ack ? "transport-closed" : ack.accepted ? "accepted" : "app-rejected";
    assert.equal(actual, expected, `${label} (${size} B): got ${actual}${ack ? ` — ${ack.message}` : ""}`);
    if (expected === "app-rejected") {
      assert.match(ack.message, /too large/, `${label}: the application error must name the reason`);
    }
  }
});

test("an empty frame is refused by name, not silently dropped", async () => {
  const res = await connect(validTicket(), { payload: new Uint8Array(0) });
  const [ack] = res.acks;
  assert.ok(ack, "an empty frame must still be acked");
  assert.equal(ack.accepted, false);
  assert.match(ack.message, /must contain bytes/);
});

test("protocol mutations do not disturb the session", async () => {
  const text = await connect(validTicket(), { payload: "a text frame where audio belongs" });
  assert.equal(text.opened, true);
  assert.deepEqual(text.acks, [], "a text frame is ignored, not acked and not fatal");

  const rapid = await new Promise((resolve) => {
    const url =
      `ws://127.0.0.1:${port}/v1/recitation-sessions/${SESSION}/audio` +
      `?ticket=${encodeURIComponent(validTicket())}`;
    const ws = new WebSocket(url);
    const acks = [];
    ws.onopen = () => {
      for (let i = 0; i < 50; i += 1) ws.send(new Uint8Array(64));
      setTimeout(() => ws.close(), 2000);
    };
    ws.onmessage = () => acks.push(1);
    ws.onerror = () => {};
    ws.onclose = () => resolve(acks.length);
  });
  assert.equal(rapid, 50, "every chunk in a burst must be acked, not silently dropped");
});

// ── the assertion the others cannot make ───────────────────────────────────────────────────────

test("the gateway is still alive, and nothing panicked", async () => {
  // A per-case assertion cannot catch a process that died on case 3 — every later case would fail
  // for the wrong reason and the panic would be buried. This is the one that would actually name it.
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "the gateway did not survive the sweep");

  const panics = stderr.split("\n").filter((line) => /panicked|RUST_BACKTRACE|attempt to (add|multiply|subtract) with overflow/.test(line));
  assert.deepEqual(panics, [], `the gateway panicked during the sweep:\n${panics.join("\n")}`);
});

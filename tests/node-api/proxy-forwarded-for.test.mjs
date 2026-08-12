import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { proxy } from "../../server/src/lib/proxy.mjs";

/**
 * The forwarding headers are the PROXY's to set, and a client does not get to choose them.
 *
 * Ported from `services/node-api` (#409). Measured on this branch before the fix: a request
 * carrying `x-forwarded-for: 203.0.113.9` reached the upstream with `x-forwarded-for: 203.0.113.9`,
 * and this service added nothing of its own. Both of platform-api's rate-limiting configurations
 * are wrong under a proxy that behaves that way:
 *
 *   TRUST_PROXY_HEADERS=1  keys on the header, so a client picks its own bucket by setting one
 *                          header and the limiter stops existing. `lib.rs:375` warns this is safe
 *                          only "behind a proxy that OVERWRITES those headers" — and this IS that
 *                          proxy.
 *   default (peer-keyed)   sees this process's address for every proxied request, collapsing all
 *                          proxied traffic into ONE bucket. One busy client throttles everyone.
 *
 * ── Why this matters here even though this service has its own limiter ──────────────────────────
 * `app.mjs` charges a token bucket on `req.ip` before anything is forwarded, which IS correct, so a
 * spoofed header is normally harmless — the local limiter throttles the real peer first. But
 * `rateLimitEnabled` is a flag, and the parity harness sets `DISABLE_RATE_LIMIT=1` in `BASE_ENV`.
 * That is the configuration the entire A/B suite runs under, so the spoofable header reaches Rust
 * in precisely the mode where nothing is in front of it — and no existing test can see it. A
 * control disabled in the harness cannot be found missing by that harness.
 *
 * ── Why this is a unit test and not a shell test ────────────────────────────────────────────────
 * `tests/node-api/shell.test.mjs` boots the whole application, which is the better level for this.
 * It cannot run in every environment: `server/src/storage/audio-object-store.mjs` imports
 * `@aws-sdk/client-s3`, so booting requires the full dependency set. `proxy()` imports only
 * `authz.mjs` and `deadline.mjs`, so this exercises the real function with no dependency at all.
 * Add the assertion to the shell test too where the SDK is available; this is the floor, not a
 * substitute.
 *
 * Hermetic: one stub upstream on loopback. No database, no Rust, no application.
 */

const CLIENT = "198.51.100.7";
const SPOOFED = "203.0.113.9";

let upstream;
let upstreamUrl;
let received;

before(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(() => new Promise((r) => upstream.close(r)));

/**
 * The parts of a Fastify request `proxy()` actually reads.
 *
 * `ip` is read with `in` rather than a destructuring default: a default fires on an EXPLICIT
 * `undefined` too, so `fakeRequest({ ip: undefined })` silently became the normal client address
 * and the no-ip case below passed for the wrong reason on its first run.
 */
function fakeRequest(overrides = {}) {
  const { headers = {}, method = "GET", url = "/v1/quran/surahs" } = overrides;
  const ip = "ip" in overrides ? overrides.ip : CLIENT;
  return { headers, ip, method, url, body: undefined, deadline: undefined };
}

/** The parts of a Fastify reply `proxy()` actually calls. */
function fakeReply() {
  const sent = { headers: {}, status: null, payload: undefined };
  const reply = {
    header(k, v) {
      sent.headers[k] = v;
      return reply;
    },
    removeHeader(k) {
      delete sent.headers[k];
      return reply;
    },
    code(c) {
      sent.status = c;
      return reply;
    },
    send(p) {
      sent.payload = p;
      return reply;
    },
    sent,
  };
  return reply;
}

async function forward(requestOverrides) {
  received = [];
  const reply = fakeReply();
  await proxy(fakeRequest(requestOverrides), reply, upstreamUrl);
  assert.equal(received.length, 1, "the request should have reached the stub upstream exactly once");
  return received[0];
}

test("a client-supplied x-forwarded-for never reaches the upstream", async () => {
  // THE assertion. Before the fix this arrived as 203.0.113.9 and Rust's governor would have keyed
  // its limiter on a value the caller chose.
  const seen = await forward({ headers: { "x-forwarded-for": SPOOFED, "x-real-ip": SPOOFED } });

  assert.equal(
    seen.headers["x-forwarded-for"],
    CLIENT,
    `the upstream received x-forwarded-for=${seen.headers["x-forwarded-for"]}. A client that can ` +
      `set this picks its own rate-limit bucket, and the limiter stops existing.`,
  );
  assert.equal(seen.headers["x-real-ip"], CLIENT, "x-real-ip is spoofable in exactly the same way");
  assert.ok(
    !JSON.stringify(seen.headers).includes(SPOOFED),
    `the spoofed address survived somewhere in the forwarded headers: ${JSON.stringify(seen.headers)}`,
  );
});

test("the header is set even when the client sent none", async () => {
  // The other half. Without this the upstream sees no forwarding header at all and falls back to
  // the peer address — which is THIS process, collapsing every proxied client into one bucket.
  const seen = await forward({ headers: {} });
  assert.equal(seen.headers["x-forwarded-for"], CLIENT);
  assert.equal(seen.headers["x-real-ip"], CLIENT);
});

test("a comma-separated chain is replaced, not appended to", async () => {
  // Appending would preserve the client's entries ahead of the real one, and every reader that
  // takes the FIRST entry — which is the conventional "original client" — would still be reading
  // an attacker-chosen value.
  const seen = await forward({
    headers: { "x-forwarded-for": `${SPOOFED}, 192.0.2.1, 192.0.2.2` },
  });
  assert.equal(seen.headers["x-forwarded-for"], CLIENT);
  assert.ok(!seen.headers["x-forwarded-for"].includes(","), "the client's chain must not survive");
});

test("every other request header is still forwarded verbatim", async () => {
  // The fix must not become a general-purpose header filter. `proxy()`'s contract is verbatim
  // except for the hop headers, and authorization in particular has to survive or every delegated
  // request becomes anonymous.
  const seen = await forward({
    headers: {
      "x-forwarded-for": SPOOFED,
      authorization: "Bearer token-value",
      "x-tenant-id": "hikmah-pilot-erbil",
      "content-type": "application/json",
      cookie: "__Host-qrai-pilot=abc",
    },
  });

  assert.equal(seen.headers.authorization, "Bearer token-value");
  assert.equal(seen.headers["x-tenant-id"], "hikmah-pilot-erbil");
  assert.equal(seen.headers.cookie, "__Host-qrai-pilot=abc");
});

test("a request with no resolvable ip leaves the client's value alone rather than inventing one", async () => {
  // `req.ip` is always present on a Fastify request, so this is a defensive branch — but the honest
  // behaviour for it is to change nothing. Writing `undefined` into the header would be worse than
  // passing the client's value through: the upstream would read the literal string "undefined" as
  // an address and bucket every such request together.
  const seen = await forward({ headers: { "x-forwarded-for": SPOOFED }, ip: undefined });
  assert.equal(seen.headers["x-forwarded-for"], SPOOFED);
  assert.ok(
    !("x-real-ip" in seen.headers) || seen.headers["x-real-ip"] !== "undefined",
    "no header may be set to the string 'undefined'",
  );
});

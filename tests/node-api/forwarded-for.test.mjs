import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { startMockUpstream, startShell } from "../api-parity/lib/harness.mjs";

/**
 * The strangler shell must tell platform-api who the client really is.
 *
 * The proxy copied every non-hop-by-hop request header through, so a client's own
 * `x-forwarded-for` reached the upstream verbatim and the shell added nothing of its own. Measured:
 * a request carrying `x-forwarded-for: 1.2.3.4` arrived upstream as `x-forwarded-for: 1.2.3.4`.
 *
 * Both of platform-api's rate-limiting configurations are wrong under a proxy that behaves that way:
 *
 *   TRUST_PROXY_HEADERS=1  keys on the header, so a client picks its own bucket with one header and
 *                          the limiter stops existing. lib.rs:375 says this setting is only safe
 *                          "behind a proxy that OVERWRITES those headers" — and this IS that proxy.
 *   default (peer-keyed)   sees the SHELL's address for every proxied request, collapsing all
 *                          proxied traffic into one bucket. One busy client throttles everyone.
 *
 * Overwriting is not a hole in the shell's "verbatim" contract. `HOP_BY_HOP` already establishes
 * that headers describing the hop belong to the proxy, and X-Forwarded-For is the definitive
 * example of one.
 *
 * Hermetic: a mock upstream, and a shell with nothing ported, so no database is touched.
 */

let upstream;
let shell;

before(async () => {
  upstream = await startMockUpstream(() => ({ status: 200, body: { ok: true } }));
  shell = await startShell({ upstream: upstream.url, env: { NODE_API_PORTED: "" } });
});
after(async () => {
  await shell?.stop();
  await upstream?.stop();
});

/** Send through the shell (nothing ported, so everything proxies) and return what upstream saw. */
async function forwarded(headers) {
  upstream.received.length = 0;
  await fetch(`${shell.baseUrl}/v1/teacher-review-queue`, {
    headers: {
      "x-tenant-id": "hikmah-pilot-erbil",
      "x-user-id": "admin-1",
      "x-user-role": "admin",
      ...headers,
    },
  });
  return upstream.received.at(-1)?.headers ?? {};
}

test("a client's x-forwarded-for is REPLACED, not passed through", async () => {
  const seen = await forwarded({ "x-forwarded-for": "1.2.3.4" });
  assert.notEqual(
    seen["x-forwarded-for"],
    "1.2.3.4",
    "the caller's claim reached the upstream — it can pick its own rate-limit bucket",
  );
  assert.ok(seen["x-forwarded-for"], "the shell must say who the client is, not stay silent");
});

test("x-real-ip is replaced too, since SmartIpKeyExtractor falls back to it", async () => {
  // Replacing only x-forwarded-for would leave the second-choice header spoofable, and a client
  // that omits the first gets to set the one that is actually used.
  const seen = await forwarded({ "x-real-ip": "5.6.7.8" });
  assert.notEqual(seen["x-real-ip"], "5.6.7.8");
});

test("neither header can be smuggled as a LIST", async () => {
  // SmartIpKeyExtractor takes the leftmost entry of x-forwarded-for. Appending the peer to a
  // client-supplied chain — the usual intermediate-proxy behaviour — would leave the client's value
  // leftmost and change nothing. The shell is the EDGE here, so it overwrites.
  const seen = await forwarded({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" });
  assert.ok(
    !String(seen["x-forwarded-for"]).includes("9.9.9.9"),
    `the client's chain survived: ${seen["x-forwarded-for"]}`,
  );
});

test("the shell sets the headers even when the client sent none", async () => {
  // The other half of the defect: with no header at all, the upstream saw only the shell's peer
  // address and keyed every proxied request to one bucket.
  const seen = await forwarded({});
  assert.ok(seen["x-forwarded-for"], "no forwarding header was set at all");
  assert.equal(seen["x-real-ip"], seen["x-forwarded-for"], "the two must name the same client");
});

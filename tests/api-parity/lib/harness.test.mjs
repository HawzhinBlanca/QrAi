import assert from "node:assert/strict";
import { createServer } from "node:net";
import test, { after } from "node:test";

import {
  HarnessError,
  TENANT,
  request,
  reservePort,
  startApi,
  startMockUpstream,
} from "./harness.mjs";

/**
 * PAR1 tests — specs/api-parity-suite/plan.md
 *
 * The harness is tested before any test is ported, because a harness that lies produces a suite
 * whose error is invisible: every test it runs agrees with every other one. These assert the four
 * ways it could lie — wrong port, adopted server, unreaped child, dropped identity headers.
 *
 * Needs a live Postgres and a built binary (both are hard requirements, never skips — see PAR5).
 */

const servers = [];
const track = (s) => (servers.push(s), s);
after(async () => {
  for (const s of servers) await s.stop();
});

// --- ports: the flake that gets blamed on the change under review ---

test("reservePort returns a port that is actually free", async () => {
  const port = await reservePort();
  // If reservePort failed to release it, this listen throws EADDRINUSE.
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => srv.close(r));
});

test("two servers start concurrently on DIFFERENT ports and both answer /health", async () => {
  // node --test runs FILES in parallel, so two config groups are live at once. A fixed port would
  // make that collide intermittently.
  const [a, b] = await Promise.all([startApi(), startApi()]);
  track(a);
  track(b);
  assert.notEqual(a.port, b.port, "two servers must not share a port");
  for (const api of [a, b]) {
    const res = await request(api.baseUrl, "/health");
    assert.equal(res.status, 200);
  }
});

// --- never adopt, never skip ---

test("a missing binary RAISES — it must never fall back to an already-running server", async () => {
  // A harness that adopted whatever answers on a well-known port would report green about a process
  // nobody chose. And a skip here is the false-green MIG5 rejected.
  await assert.rejects(
    () => startApi({ bin: "services/platform-api/target/debug/does-not-exist" }),
    (err) => {
      assert.ok(err instanceof HarnessError);
      assert.match(err.message, /binary not found/);
      assert.match(err.message, /never a skip/);
      return true;
    },
  );
});

test("a server that exits during startup RAISES with its stderr, not a timeout", async () => {
  // ALLOW_INSECURE_DEFAULTS=0 un-relaxes `ensure_secure_config()`, which then panics on one of the
  // production controls. The claim under test is the HARNESS's: it must surface that panic rather
  // than stall for the full 30s health timeout.
  //
  // WHICH control panics first is incidental to that claim, and this assertion used to pin it to
  // the secrets. `ALLOW_HEADER_AUTH` now has a boot refusal too, and is checked first — BASE_ENV
  // sets it to "1" for every group, so with the relax switched off it is the first to fail. The
  // alternation keeps the assertion meaningful (real panic text reached us) without pinning an
  // ordering this test does not care about.
  await assert.rejects(
    () => startApi({ env: { ALLOW_INSECURE_DEFAULTS: "0" }, timeoutMs: 20_000 }),
    (err) => {
      assert.match(err.message, /exited during startup/);
      assert.match(err.message, /ALLOW_HEADER_AUTH|JWT_SECRET|REALTIME_GATEWAY_TICKET_SECRET/);
      return true;
    },
  );
});

// --- stop() must actually reap: an orphan holds its port and its DB connections ---

test("stop() releases the port — an orphan would leak connections and eventually exhaust ports", async () => {
  const api = await startApi();
  const { port } = api;
  await api.stop();

  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => srv.close(r));
});

test("stop() is idempotent", async () => {
  const api = await startApi();
  await api.stop();
  await api.stop();
});

// --- request(): the identity shape is the whole basis of every auth assertion ---

test("request sends the dev-header identity, and role maps to the seeded user id", async () => {
  // If this mapping were wrong, every ownership test would be testing the wrong learner and would
  // still pass — the exact silent-transcription failure PAR4 exists to catch.
  const mock = await startMockUpstream(() => ({ status: 200, body: { ok: true } }));
  await request(mock.url, "/echo", { method: "POST", role: "teacher", body: { a: 1 } });
  await mock.stop();

  const [seen] = mock.received;
  assert.equal(seen.headers["x-user-role"], "teacher");
  assert.equal(seen.headers["x-user-id"], "teacher-1");
  assert.equal(seen.headers["x-tenant-id"], TENANT);
  assert.deepEqual(seen.body, { a: 1 });
});

test("request omits identity headers entirely when no role is given", async () => {
  const mock = await startMockUpstream();
  await request(mock.url, "/anon", { method: "POST", tenant: null });
  await mock.stop();

  const [seen] = mock.received;
  assert.equal(seen.headers["x-user-role"], undefined);
  assert.equal(seen.headers["x-tenant-id"], undefined);
});

test("request returns raw text for a non-JSON body", async () => {
  // /metrics is Prometheus text; a test asserting on it must see it verbatim, not [object Object].
  const mock = await startMockUpstream(() => ({
    status: 200,
    body: "http_requests_total 3",
    contentType: "text/plain",
  }));
  const res = await request(mock.url, "/metrics");
  await mock.stop();

  assert.equal(res.body, "http_requests_total 3");
});

// --- the mock upstream records what was FORWARDED ---

test("startMockUpstream records the forwarded body and allows swapping behaviour per test", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: { first: true } }));
  const one = await request(mock.url, "/v1/x", { method: "POST", body: { n: 1 } });
  assert.deepEqual(one.body, { first: true });

  mock.respond = () => ({ status: 500, body: "boom", contentType: "text/plain" });
  const two = await request(mock.url, "/v1/x", { method: "POST", body: { n: 2 } });
  assert.equal(two.status, 500);
  await mock.stop();

  assert.equal(mock.received.length, 2);
  assert.deepEqual(
    mock.received.map((r) => r.body.n),
    [1, 2],
  );
});

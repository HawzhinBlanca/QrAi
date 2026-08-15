import assert from "node:assert/strict";
import test from "node:test";

import {
  BURST,
  REPLENISH_MS,
  clientKey,
  createRateLimiter,
} from "../../services/node-api/lib/rate-limit.mjs";

/**
 * The port of platform-api's tower_governor layer (lib.rs:366).
 *
 * Rate limiting is ON by default in Rust; this port had none, and POST /v1/auth/token and
 * POST /v1/pilot/session/bootstrap are both PORTABLE — the invitation exchange would have been
 * brute-forceable at cutover.
 *
 * Nothing compared them, and the reason is worth recording: `tests/api-parity/lib/harness.mjs` sets
 * DISABLE_RATE_LIMIT=1 in BASE_ENV, so the limiter has never been exercised in the parity suite in
 * EITHER service. A control switched off in the harness cannot be found missing by it.
 *
 * Time is INJECTED here rather than slept. A limiter tested with real sleeps is a slow test that
 * only ever visits one point on the curve; these visit the boundaries.
 */

/** A clock the test drives. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("the parameters are Rust's, and are a REPLENISH PERIOD not a rate", () => {
  // `.per_millisecond(50)` is the time to regain ONE token. lib.rs carries a comment about the
  // previous `per_second(60)` having meant "1 request per 60s" after the burst — reading these as a
  // rate is the exact error that caused, so the numbers are pinned with their meaning.
  assert.equal(BURST, 200, "lib.rs .burst_size(200)");
  assert.equal(REPLENISH_MS, 50, "lib.rs .per_millisecond(50)");
});

test("the full burst passes, and the next request does not", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  for (let i = 0; i < BURST; i += 1) {
    assert.equal(limiter.take("1.1.1.1").allowed, true, `request ${i + 1} of the burst was rejected`);
  }
  const over = limiter.take("1.1.1.1");
  assert.equal(over.allowed, false, "the 201st request in the same instant was allowed");
  assert.equal(over.waitSeconds, 0, "a 50ms replenish floors to 0 seconds, as tower_governor reports");
});

test("one token returns per 50ms, and the bucket refills no faster", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  for (let i = 0; i < BURST; i += 1) limiter.take("k");
  assert.equal(limiter.take("k").allowed, false);

  clock.advance(49);
  assert.equal(limiter.take("k").allowed, false, "a token appeared before the replenish period");

  clock.advance(1); // 50ms total
  assert.equal(limiter.take("k").allowed, true, "no token after a full replenish period");
  assert.equal(limiter.take("k").allowed, false, "two tokens appeared where one was earned");
});

test("sustained rejection does not lock the bucket forever", () => {
  // The bug this shape invites: refreshing `updatedAt` on a REJECTED request restarts the clock, so
  // a client that keeps trying never refills. It looks identical to a working limiter until someone
  // stops and waits, which under real load nobody does.
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  for (let i = 0; i < BURST; i += 1) limiter.take("k");

  // NINE steps of 5ms = 45ms: still short of one replenish period, so every one must be refused.
  // Ten would reach exactly 50ms, where a token is legitimately owed — the first version of this
  // test looped ten times and failed on its own arithmetic, not on the limiter.
  for (let i = 0; i < 9; i += 1) {
    clock.advance(5);
    assert.equal(limiter.take("k").allowed, false, `refused-request ${i + 1} came back allowed`);
  }
  clock.advance(5); // 50ms since the bucket emptied
  assert.equal(limiter.take("k").allowed, true, "the bucket never refilled while being hammered");
});

test("the bucket cannot refill past the burst", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  limiter.take("k");
  clock.advance(60 * 60 * 1000); // an hour idle
  for (let i = 0; i < BURST; i += 1) {
    assert.equal(limiter.take("k").allowed, true, `request ${i + 1} after idling was rejected`);
  }
  assert.equal(limiter.take("k").allowed, false, "an idle hour granted more than the burst");
});

test("keys are independent — one client cannot throttle another", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  for (let i = 0; i < BURST; i += 1) limiter.take("noisy");
  assert.equal(limiter.take("noisy").allowed, false);
  assert.equal(limiter.take("quiet").allowed, true, "an unrelated client was throttled");
});

test("the key map is bounded, so it is not itself a memory-exhaustion vector", () => {
  // An unbounded per-IP map IS the attack: a spoofed X-Forwarded-For mints a fresh entry per
  // request. The realtime gateway had this exact bug found and fixed in its ticket store; a
  // component whose purpose is surviving abuse must not reintroduce it.
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now });
  for (let i = 0; i < 120_000; i += 1) limiter.take(`ip-${i}`);
  assert.ok(limiter.size <= 100_000, `the map grew to ${limiter.size} keys`);
});

// --- key extraction ---

const reqWith = (headers, ip = "10.0.0.1") => ({ headers, ip });

test("by default the PEER address is charged, not a header a client can set", () => {
  const req = reqWith({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" });
  assert.equal(clientKey(req, false), "10.0.0.1", "a spoofable header decided the bucket");
});

test("TRUST_PROXY_HEADERS prefers x-forwarded-for's LEFTMOST entry, then x-real-ip", () => {
  // SmartIpKeyExtractor's order. Leftmost because that is the original client; taking the last
  // would charge every request to the nearest proxy and collapse the limiter to one bucket.
  assert.equal(clientKey(reqWith({ "x-forwarded-for": "9.9.9.9, 10.0.0.2, 10.0.0.3" }), true), "9.9.9.9");
  assert.equal(clientKey(reqWith({ "x-real-ip": "8.8.8.8" }), true), "8.8.8.8");
  assert.equal(clientKey(reqWith({}), true), "10.0.0.1", "with neither header, fall back to the peer");
  // A header present but empty must not become the key: every such request would share one bucket.
  assert.equal(clientKey(reqWith({ "x-forwarded-for": "   " }), true), "10.0.0.1");
});

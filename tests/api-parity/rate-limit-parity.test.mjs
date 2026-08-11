import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi } from "./lib/harness.mjs";

/**
 * The rate limiter, exercised — which no parity test has ever done, in either service.
 *
 * `tests/api-parity/lib/harness.mjs` sets DISABLE_RATE_LIMIT=1 in BASE_ENV, for a good reason: 39
 * suites sharing one process would throttle each other and the failures would land anywhere. The
 * cost is that the limiter was switched off in the only place that compares the two services. So
 * when the Node port shipped without one, nothing could notice. A control disabled in the harness
 * cannot be found missing by it.
 *
 * This file turns it back ON for its own server, which is why it is a separate file rather than a
 * test inside an existing one.
 *
 * Runs in BOTH passes. Under PARITY_THROUGH_SHELL=1 the Node port answers and must behave the same;
 * that is the whole point, and it is why the assertions are absolute rather than an `assertAB`
 * (which would put Node on both sides — harness.mjs:425).
 */

const BURST = 200; // lib.rs .burst_size(200)

let api;

before(async () => {
  // Spread AFTER BASE_ENV, so this beats the harness-wide disable.
  api = await startApi({ env: { DISABLE_RATE_LIMIT: "0" } });
});
after(async () => {
  await api?.stop();
});

/** Fire sequentially until refused, or give up. Sequential so the count means something. */
async function hammer(path, limit) {
  for (let i = 1; i <= limit; i += 1) {
    const res = await request(api.baseUrl, path);
    if (res.status === 429) return { at: i, res };
  }
  return { at: null, res: null };
}

test("a burst is eventually refused with 429", async () => {
  // Not an exact count: the bucket replenishes one token per 50ms and these requests take real
  // time, so the exact index drifts with machine speed. Asserting `=== 201` would be a flaky test
  // pretending to be a precise one. What must hold is that the limit EXISTS and is near the
  // configured burst — a limiter that never engages, and one that engages at 5, are both failures.
  const { at, res } = await hammer("/health", BURST * 3);
  assert.ok(at !== null, `no 429 in ${BURST * 3} requests — the limiter is not engaged at all`);
  assert.ok(
    at > BURST * 0.5,
    `throttled after only ${at} requests against a burst of ${BURST} — far stricter than configured`,
  );

  // Byte-identical to tower_governor's, observed from the running Rust service. A nicer JSON error
  // in the port would be a divergence on every throttled request.
  assert.equal(res.text, `Too Many Requests! Wait for 0s`);
  assert.equal(res.headers.get("retry-after"), "0");
  assert.equal(res.headers.get("x-ratelimit-after"), "0");
});

test("the 429 still carries CORS headers a browser can read", async () => {
  // lib.rs:410 — CORS is OUTERMOST precisely so a genuine 429 is readable cross-origin. If the
  // limiter short-circuited before CORS, a throttled browser client would see an opaque network
  // error instead of a status it can act on.
  const { res } = await hammer("/health", BURST * 3);
  assert.ok(res, "never reached a 429");
  assert.ok(
    res.headers.get("vary") !== null || res.headers.get("access-control-allow-origin") !== null,
    "the throttled response carried no CORS headers — the limiter is outside cors",
  );
});

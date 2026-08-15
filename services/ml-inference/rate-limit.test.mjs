// P5.4 — the ML rate limiter's two budgets.
//
// ── The ceiling this exists to pin ──────────────────────────────────────────────────────────────
// Every learner's analysis reaches ml-inference through platform-api's proxy, and platform-api does
// not forward `x-forwarded-for`. From here, all traffic from all learners in all tenants arrives
// from ONE address. With a single per-IP budget of 100/min that capped the entire platform at 100 ML
// requests per minute, shared — a class of twenty children practising would 429 each other.
//
// It was measured rather than reasoned about: P5.4's k6 run reported a 73.8% error rate at 10 VUs
// and 78.1% at 50. Those are the limiter's 429s, not the service failing, and no unit test in this
// repo could have shown it because none of them send a hundred requests.
//
// Needs a REAL server on a real socket: the limiter lives in the `createServer` handler, above
// `route()`, so importing the module cannot reach it. The child gets a small trusted budget so the
// test can prove the ceiling still EXISTS without sending six thousand requests.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8391;
const KEY = "rate-limit-test-key";
const TRUSTED_MAX = 110; // > the 100 per-IP budget, and small enough to exhaust in a test
const ANON_MAX = 100; // RATE_LIMIT_MAX in server.mjs

let child;
let base;

before(async () => {
  child = spawn(process.execPath, [join(here, "server.mjs")], {
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(PORT),
      ML_API_KEY: KEY,
      ML_TRUSTED_RATE_LIMIT_MAX: String(TRUSTED_MAX),
      AUDIO_STORAGE_DIR: mkdtempSync(join(tmpdir(), "ml-ratelimit-test-")),
      ALLOW_INSECURE_DEFAULTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("ml-inference did not start");
});

after(() => child?.kill());

/** Fire `n` sequential requests at a path that needs no body, and tally the statuses. */
async function fire(n, headers) {
  const statuses = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/v1/rate-limit-probe`, { headers });
    statuses.push(res.status);
  }
  return statuses;
}

test("an ANONYMOUS caller is still cut off at the per-IP budget", async () => {
  // The budget that stops abuse is unchanged — that is the half of this the fix must not loosen.
  const statuses = await fire(ANON_MAX + 5, {});
  const limited = statuses.filter((s) => s === 429).length;
  assert.ok(limited > 0, "an anonymous flood was never rate-limited");
  assert.equal(
    statuses[0],
    401,
    "the first anonymous request should be rejected on the key, not the limiter",
  );
});

test("an AUTHENTICATED caller is not capped at the anonymous budget", async () => {
  // Runs AFTER the anonymous flood above has already exhausted `ip:127.0.0.1`. If the two shared a
  // bucket — which is exactly the production bug — every one of these would 429.
  const statuses = await fire(ANON_MAX + 5, { "x-ml-api-key": KEY });
  const limited = statuses.filter((s) => s === 429).length;
  assert.equal(
    limited,
    0,
    `platform-api was throttled after the anonymous budget ran out (${limited} of ${statuses.length} 429ed) — ` +
      "the whole platform shares this bucket, so that is every learner at once",
  );
});

test("but the trusted budget is a CEILING, not an exemption", async () => {
  // If ML_API_KEY leaks, "authenticated" stops meaning "trustworthy". An unbounded budget would make
  // this service the cheapest way to take the platform down, so a limit remains — just a usable one.
  // 105 have been spent by the test above; TRUSTED_MAX is 110.
  const statuses = await fire(20, { "x-ml-api-key": KEY });
  assert.ok(
    statuses.includes(429),
    `the trusted budget of ${TRUSTED_MAX} was never enforced; a leaked key would be unlimited`,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../../server/src/app.mjs";
import { createTokenBucketLimiter } from "../../server/src/lib/admission.mjs";

test("the token bucket has exact burst, refill, and bounded retry behavior", () => {
  let now = 1_000;
  const limiter = createTokenBucketLimiter({
    capacity: 2,
    refillIntervalMs: 50,
    maxKeys: 4,
    idleTtlMs: 1_000,
    now: () => now,
  });

  assert.deepEqual(limiter.consume("client"), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume("client"), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume("client"), { allowed: false, retryAfterMs: 50 });
  now += 49;
  assert.deepEqual(limiter.consume("client"), { allowed: false, retryAfterMs: 1 });
  now += 1;
  assert.deepEqual(limiter.consume("client"), { allowed: true, retryAfterMs: 0 });
  now += 5_000;
  assert.deepEqual(limiter.consume("client"), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume("client"), { allowed: true, retryAfterMs: 0 });
  assert.equal(limiter.consume("client").allowed, false, "refill exceeded the capacity");
});

test("client state has a hard ceiling with idle and LRU eviction and no per-key timers", () => {
  let now = 0;
  const limiter = createTokenBucketLimiter({
    capacity: 1,
    refillIntervalMs: 10_000,
    maxKeys: 2,
    idleTtlMs: 100,
    now: () => now,
  });

  limiter.consume("idle-a");
  limiter.consume("idle-b");
  assert.equal(limiter.size, 2);
  now = 101;
  limiter.consume("new-a");
  assert.equal(limiter.size, 1, "expired buckets were retained");
  assert.equal(limiter.consume("idle-a").allowed, true, "idle-a was not evicted and recreated");
  assert.equal(limiter.size, 2);

  now = 102;
  limiter.consume("idle-a"); // touch as most-recently-used; it is empty and remains denied
  limiter.consume("new-b");
  assert.equal(limiter.size, 2);
  assert.equal(limiter.consume("new-a").allowed, true, "least-recently-used bucket was not evicted");
  assert.equal(limiter.size, 2);
});

test("forwarded IP rotation cannot bypass admission unless trusted proxy hops are enabled", async (t) => {
  const direct = createApplication({
    logger: false,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000 },
  });
  t.after(() => direct.close());
  await direct.ready();

  const first = await direct.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "10.0.0.8",
    headers: { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.1" },
  });
  const spoofed = await direct.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "10.0.0.8",
    headers: { "x-forwarded-for": "203.0.113.2", "x-real-ip": "203.0.113.2" },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(spoofed.statusCode, 429, "untrusted forwarded headers minted a fresh bucket");

  const proxied = createApplication({
    logger: false,
    trustedProxyHops: 1,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 60_000 },
  });
  t.after(() => proxied.close());
  await proxied.ready();

  /** @type {import("fastify").InjectOptions} */
  const clientA = {
    method: "GET",
    url: "/health",
    remoteAddress: "10.0.0.8",
    headers: { "x-forwarded-for": "203.0.113.10" },
  };
  assert.equal((await proxied.inject(clientA)).statusCode, 200);
  assert.equal((await proxied.inject(clientA)).statusCode, 429);
  assert.equal(
    (
      await proxied.inject({
        ...clientA,
        headers: { "x-forwarded-for": "203.0.113.11" },
      })
    ).statusCode,
    200,
    "explicit trusted-hop mode did not separate proxy-reported clients",
  );
});

test("the 2 MiB default and 16 MiB ASR body ceilings are executable boundaries", async (t) => {
  const app = createApplication({ logger: false, rateLimitEnabled: false });
  t.after(() => app.close());
  await app.ready();

  const body = JSON.stringify({ audio: "x".repeat(2 * 1024 * 1024) });
  const regular = await app.inject({
    method: "POST",
    url: "/v1/ml/alignments:predict",
    headers: { "content-type": "application/json" },
    payload: body,
  });
  assert.equal(regular.statusCode, 413);

  const asr = await app.inject({
    method: "POST",
    url: "/v1/asr/transcribe",
    headers: { "content-type": "application/json" },
    payload: body,
  });
  assert.equal(asr.statusCode, 401, "ASR incorrectly inherited the 2 MiB default ceiling");
  assert.deepEqual(asr.json(), { error: "missing or invalid authorization" });
});

test("unexpected errors and hostile credentials are redacted at the outer boundary", async (t) => {
  const app = createApplication({ logger: false, rateLimitEnabled: false });
  app.get("/__boundary-test/error", async () => {
    throw new Error("postgresql://role:secret@db.internal/quran learner@example.test");
  });
  app.get("/__boundary-test/status-error", async () => {
    const error = new Error("secret dependency detail from db.internal");
    error.statusCode = 503;
    throw error;
  });
  t.after(() => app.close());
  await app.ready();

  const failure = await app.inject({ method: "GET", url: "/__boundary-test/error" });
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.json(), { error: "internal error" });
  assert.doesNotMatch(failure.body, /secret|db\.internal|learner@example|postgres/i);

  const disguised = await app.inject({ method: "GET", url: "/__boundary-test/status-error" });
  assert.equal(disguised.statusCode, 500, "an arbitrary statusCode bypassed unexpected-error shaping");
  assert.deepEqual(disguised.json(), { error: "internal error" });
  assert.doesNotMatch(disguised.body, /secret|db\.internal|dependency/i);

  const authorization = "Bearer credential-that-must-never-return";
  const hostile = await app.inject({
    method: "GET",
    url: "/v1/learner/progress",
    headers: { authorization },
  });
  assert.equal(hostile.statusCode, 401);
  assert.deepEqual(hostile.json(), { error: "missing or invalid authorization" });
  assert.doesNotMatch(hostile.body, /credential-that-must-never-return/);
});

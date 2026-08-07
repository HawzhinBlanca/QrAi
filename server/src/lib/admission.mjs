/**
 * Bounded in-process HTTP admission control (ADR-0050 / W2.10).
 *
 * One token bucket per resolved client IP. The Map is also the LRU list: every access moves its
 * bucket to the end, so eviction needs no timer, queue, or second index. This is volumetric defense
 * in depth; authorization and durable credential/replay decisions live elsewhere.
 */

const positiveInteger = (name, value) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive whole number`);
  }
};

export function createTokenBucketLimiter(options = {}) {
  const {
    capacity = 200,
    refillIntervalMs = 50,
    maxKeys = 10_000,
    idleTtlMs = 10 * 60 * 1_000,
    now = () => performance.now(),
  } = options;

  positiveInteger("capacity", capacity);
  positiveInteger("refillIntervalMs", refillIntervalMs);
  positiveInteger("maxKeys", maxKeys);
  positiveInteger("idleTtlMs", idleTtlMs);
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const buckets = new Map();

  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("admission clock must return a finite non-negative number");
    }
    return value;
  };

  const evictForNewKey = (at) => {
    for (const [key, bucket] of buckets) {
      if (at - bucket.lastSeenMs >= idleTtlMs) buckets.delete(key);
    }
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };

  const consume = (key) => {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("admission key must be a non-empty string");
    }

    const at = clock();
    let bucket = buckets.get(key);
    if (bucket && at - bucket.lastSeenMs >= idleTtlMs) {
      buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      evictForNewKey(at);
      bucket = { tokens: capacity, lastRefillMs: at, lastSeenMs: at };
    } else {
      const elapsed = Math.max(0, at - bucket.lastRefillMs);
      const replenished = Math.floor(elapsed / refillIntervalMs);
      if (replenished > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + replenished);
        bucket.lastRefillMs += replenished * refillIntervalMs;
      }
      bucket.lastSeenMs = at;
      buckets.delete(key);
    }
    buckets.set(key, bucket);

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }

    const sinceRefill = Math.max(0, at - bucket.lastRefillMs);
    return {
      allowed: false,
      retryAfterMs: Math.max(1, Math.ceil(refillIntervalMs - sinceRefill)),
    };
  };

  return {
    consume,
    get size() {
      return buckets.size;
    },
  };
}

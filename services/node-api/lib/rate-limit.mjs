/**
 * The port of platform-api's `tower_governor` layer (lib.rs:366).
 *
 * Rate limiting is ON BY DEFAULT in the Rust service and `DISABLE_RATE_LIMIT=1` turns it off. This
 * port had NO limiter at all, and `POST /v1/auth/token` and `POST /v1/pilot/session/bootstrap` are
 * both in PORTABLE — so at cutover the invitation exchange would be brute-forceable, with the
 * throttle silently gone rather than deliberately removed.
 *
 * Nothing compared them: `tests/api-parity/lib/harness.mjs` sets `DISABLE_RATE_LIMIT=1` in BASE_ENV,
 * so no parity test has ever exercised the limiter in EITHER service.
 *
 * ── The parameters are Rust's, and they are not a rate ────────────────────────────────────────
 * `per_millisecond(50)` sets the REPLENISH PERIOD — the time to regain ONE request — not a rate.
 * With `burst_size(200)` that is a 200-token bucket refilling one token every 50ms (~20 req/s
 * sustained). lib.rs carries a comment about the previous `per_second(60)` meaning "1 request per
 * 60s" after the burst; transcribing these as a rate would reintroduce exactly that class of error.
 *
 * ── The 429 was OBSERVED, not read off the crate ──────────────────────────────────────────────
 * Hammering the Rust service until it rejected produced, verbatim:
 *
 *     status  429
 *     body    Too Many Requests! Wait for 0s     (plain text; tower_governor sets NO content-type)
 *     headers retry-after: 0 · x-ratelimit-after: 0
 *
 * The differ compares bodies and headers, so a nicer JSON error here would be a divergence.
 */

/** Rust: `.burst_size(200)`. */
export const BURST = 200;
/** Rust: `.per_millisecond(50)` — the time to regain ONE token. */
export const REPLENISH_MS = 50;

/**
 * Bound on distinct keys held at once.
 *
 * An unbounded per-IP map IS the memory-exhaustion vector: one entry per source address, and a
 * spoofed `X-Forwarded-For` mints a fresh one per request. The realtime gateway already had this
 * exact bug found and fixed in its ticket store, and reintroducing it in a component whose whole
 * purpose is surviving abuse would be worse than having no limiter.
 *
 * Full buckets are indistinguishable from absent ones, so eviction of idle keys is lossless: a key
 * at full capacity that is dropped and recreated behaves identically.
 */
const MAX_KEYS = 100_000;

/**
 * Which client a request is charged to.
 *
 * Default is the PEER address. Behind a reverse proxy every request shares the proxy's address and
 * the limiter collapses to one global bucket, so `TRUST_PROXY_HEADERS=1` keys off the forwarded
 * headers instead — matching `SmartIpKeyExtractor`, which prefers `x-forwarded-for` (LEFTMOST
 * entry, the original client), then `x-real-ip`, then the peer.
 *
 * Opt-in because it is spoofable when the service is exposed directly: a client that can set the
 * header picks its own bucket and the limit stops existing. Only enable behind a proxy that
 * OVERWRITES those headers.
 */
export function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim() !== "") {
      return forwarded.split(",")[0].trim();
    }
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real.trim() !== "") return real.trim();
  }
  return req.ip ?? "unknown";
}

/**
 * A token bucket per key, with Rust's parameters.
 *
 * `now` is injected so the tests can advance time instead of sleeping. A limiter tested with real
 * sleeps is a slow test that only ever exercises one point on the curve.
 */
export function createRateLimiter({ burst = BURST, replenishMs = REPLENISH_MS, now = Date.now } = {}) {
  /** key -> { tokens, updatedAt } */
  const buckets = new Map();

  function evictIfNeeded() {
    if (buckets.size <= MAX_KEYS) return;
    // Drop the least recently seen. Insertion order is Map's iteration order, and every `take`
    // re-inserts, so the front of the map is the stalest.
    const excess = buckets.size - MAX_KEYS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }

  return {
    /**
     * Charge one request to `key`.
     *
     * Returns `{ allowed: true }`, or `{ allowed: false, waitSeconds }` where `waitSeconds` is
     * whole seconds until a token exists — floored, as tower_governor's `Wait for {n}s` is, which
     * is why a 50ms replenish always reports 0.
     */
    take(key) {
      const t = now();
      const existing = buckets.get(key);
      let tokens;
      if (existing === undefined) {
        tokens = burst;
      } else {
        buckets.delete(key); // re-insert, so iteration order stays least-recently-used first
        const elapsed = t - existing.updatedAt;
        tokens = Math.min(burst, existing.tokens + Math.floor(elapsed / replenishMs));
      }

      if (tokens < 1) {
        // No token yet. Keep `updatedAt` where it was, or a stream of rejected requests would keep
        // resetting the clock and the bucket would never refill — a limiter that locks out forever
        // under sustained load, which looks identical to one that works until someone waits.
        buckets.set(key, { tokens, updatedAt: existing.updatedAt });
        evictIfNeeded();
        return { allowed: false, waitSeconds: Math.floor(replenishMs / 1000) };
      }

      buckets.set(key, { tokens: tokens - 1, updatedAt: t });
      evictIfNeeded();
      return { allowed: true };
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * Send the rejection exactly as tower_governor does. See the observed values above.
 *
 * `.type()` is deliberately NOT set: the Rust response carries no content-type, and adding one
 * would be a header divergence on every throttled request.
 */
export function sendTooManyRequests(reply, waitSeconds) {
  reply
    .code(429)
    .header("retry-after", String(waitSeconds))
    .header("x-ratelimit-after", String(waitSeconds))
    .send(`Too Many Requests! Wait for ${waitSeconds}s`);
}

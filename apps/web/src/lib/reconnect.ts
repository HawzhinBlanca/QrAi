/**
 * Reconnect policy + bounded buffering for the realtime audio upload (T13).
 *
 * Pure and dependency-free — no WebSocket, no timers, no globals — so the whole reconnect decision
 * surface is unit-testable without a network. `startGatewayAudioUpload` (lib/liveRecitation.ts) is
 * the only consumer; it supplies the real clock/socket.
 */

export interface ReconnectPolicy {
  /** Delay for the first retry, before jitter. */
  baseDelayMs: number;
  /** Ceiling for the exponential term, before jitter. */
  maxDelayMs: number;
  /** After this many consecutive failed attempts, stop and degrade to batch. */
  maxAttempts: number;
}

/** Tuned for classroom Wi-Fi: recover fast from a blip, give up before the learner is left waiting. */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 6,
};

export type ReconnectDecision =
  | { action: "retry"; delayMs: number }
  | { action: "give-up"; reason: "max-attempts" };

/**
 * Decide whether to retry after a dropped connection, and how long to wait.
 *
 * `attempt` is 1-based: the first retry after a drop is attempt 1. Uses EQUAL JITTER — the delay is
 * drawn from [exp/2, exp] rather than exactly `exp`. A whole classroom hits the same Wi-Fi blip at
 * once, so a fixed backoff would have every client reconnect in lockstep and hammer the gateway in
 * synchronised waves (thundering herd); jitter spreads them out. Equal jitter (rather than full
 * jitter over [0, exp]) keeps a guaranteed minimum wait so a hard-down gateway isn't retried
 * instantly. `random` is injected so the sequence is deterministic in tests.
 */
export function planReconnect(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): ReconnectDecision {
  if (attempt > policy.maxAttempts) {
    return { action: "give-up", reason: "max-attempts" };
  }
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const half = exponential / 2;
  return { action: "retry", delayMs: Math.round(half + half * random()) };
}

/**
 * Append `item` to `buffer`, dropping the OLDEST entries to stay within `max`. Returns how many were
 * dropped by this push (0 when it fit).
 *
 * Bounded because the buffer holds raw audio while disconnected: an unbounded one turns a long
 * outage into an out-of-memory crash — the opposite of resilience. Drop-oldest (not newest) because
 * on resume the most RECENT audio is what the learner is actually reciting; stale audio from 60s ago
 * is worth less than the words being said now. Callers surface the dropped count to the learner
 * rather than silently losing recitation.
 */
export function pushBoundedDropOldest<T>(buffer: T[], item: T, max: number): number {
  if (max <= 0) return 1; // buffering disabled — the item itself is dropped
  buffer.push(item);
  let dropped = 0;
  while (buffer.length > max) {
    buffer.shift();
    dropped += 1;
  }
  return dropped;
}

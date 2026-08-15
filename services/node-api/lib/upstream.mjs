/**
 * How long a call to an ML/ASR upstream may hang before it is abandoned.
 *
 * The Rust original (`services/platform-api/src/lib.rs`, `upstream_timeout`) has enforced this
 * since the client was written, and this port did not. Every `fetch` in `routes/` was issued with
 * no signal at all, and Node's global fetch has no request deadline of its own — so a wedged ML
 * process (the realistic GPU/MPS fault: socket accepted, request read, no response ever) held the
 * request open indefinitely. Measured against a mock that accepts and never answers, with
 * UPSTREAM_TIMEOUT_SECS=3: the Rust service returned 502 after 3013ms, this one was still hanging
 * at 30s when the probe gave up.
 *
 * It survived because `tests/api-parity/upstream-hang.test.mjs` — which exists precisely to fire
 * this timeout — was never in the THROUGH-SHELL list, so it only ever exercised Rust. ADR-0034: a
 * port is only ported where something compares it. That list now includes it.
 *
 * ── Parsing strictly, for the reason the Rust does ────────────────────────────────────────────
 * A knob whose bad values are accepted silently is worse than no knob: the operator believes they
 * set 5 seconds and the service is still waiting 60. `UPSTREAM_TIMEOUT_SECS=6O` — capital letter O
 * — must refuse to boot, not become a default nobody chose.
 */

/** Matches `DEFAULT_UPSTREAM_TIMEOUT_SECS` in lib.rs. */
export const DEFAULT_UPSTREAM_TIMEOUT_SECS = 60;

/**
 * The largest value `AbortSignal.timeout()` can express: its argument is clamped to a 32-bit
 * signed millisecond count, and anything above throws at CALL time — i.e. per request, as a 500,
 * long after boot. Rust's `u64` seconds has no such ceiling, so this is a DELIBERATE divergence:
 * a value the original accepts and this port physically cannot honour is refused at startup, where
 * an operator sees it, rather than accepted into a service that will fail every ML call at runtime.
 */
const MAX_TIMEOUT_SECS = Math.floor(2 ** 31 / 1000);

/**
 * Resolve `UPSTREAM_TIMEOUT_SECS` from an environment, in milliseconds.
 *
 * THROWS on a value it cannot honour. The caller exits non-zero — see server.mjs. Returning a
 * fallback here is the exact failure this parses strictly to avoid.
 */
export function upstreamTimeoutMs(env = process.env) {
  const raw = (env.UPSTREAM_TIMEOUT_SECS ?? "").trim();
  if (raw === "") return DEFAULT_UPSTREAM_TIMEOUT_SECS * 1000;

  // `+5` is accepted because Rust's `u64::from_str` accepts a leading plus and this is a port.
  // Everything else — `6O`, `5s`, `5.0`, `-1`, `1_000` — is a value nobody meant.
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(
      `UPSTREAM_TIMEOUT_SECS must be a whole number of seconds, got ${JSON.stringify(raw)}`,
    );
  }
  const secs = Number(raw);

  // Rust refuses 0 because reqwest reads a zero Duration as "no timeout", restoring the unbounded
  // hang. Here 0 would do the OPPOSITE — AbortSignal.timeout(0) aborts before the request is even
  // sent, failing every ML call instantly. Same refusal, and the reasons genuinely differ; a
  // comment claiming reqwest's reason in a file with no reqwest in it would be a copied lie.
  // What they share is that 0 is the value an operator reaches for to make things STRICTER and
  // neither runtime does anything they would want.
  if (secs === 0) {
    throw new Error(
      "UPSTREAM_TIMEOUT_SECS=0 aborts every ML/ASR call before it is sent (AbortSignal.timeout(0) " +
        "fires immediately). Set a positive number of seconds.",
    );
  }
  if (secs > MAX_TIMEOUT_SECS) {
    throw new Error(
      `UPSTREAM_TIMEOUT_SECS=${secs} exceeds the ${MAX_TIMEOUT_SECS}s this runtime can express ` +
        "(AbortSignal.timeout takes a 32-bit millisecond count). Set a smaller number of seconds.",
    );
  }
  return secs * 1000;
}

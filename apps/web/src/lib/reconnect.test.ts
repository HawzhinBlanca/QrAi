import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONNECT_POLICY,
  planReconnect,
  pushBoundedDropOldest,
  type ReconnectPolicy,
} from "./reconnect";

const policy: ReconnectPolicy = { baseDelayMs: 500, maxDelayMs: 15_000, maxAttempts: 6 };

describe("planReconnect", () => {
  it("backs off exponentially across attempts", () => {
    // random() = 1 -> the top of the equal-jitter window, i.e. the full exponential term.
    const delays = [1, 2, 3, 4, 5].map((n) => planReconnect(n, policy, () => 1));
    expect(delays.map((d) => (d.action === "retry" ? d.delayMs : -1))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });

  it("clamps the exponential term at maxDelayMs", () => {
    // attempt 6 would be 500 * 2^5 = 16000 > 15000 cap.
    expect(planReconnect(6, policy, () => 1)).toEqual({ action: "retry", delayMs: 15_000 });
  });

  it("applies equal jitter: the delay is drawn from [exp/2, exp], never 0", () => {
    // A whole classroom drops at once; identical delays would reconnect in lockstep. Jitter spreads
    // them, but must still guarantee a minimum wait.
    const lowest = planReconnect(3, policy, () => 0); // exp = 2000 -> floor is exp/2
    const highest = planReconnect(3, policy, () => 1);
    expect(lowest).toEqual({ action: "retry", delayMs: 1000 });
    expect(highest).toEqual({ action: "retry", delayMs: 2000 });
    // Different clients (different random draws) get different delays.
    const a = planReconnect(3, policy, () => 0.25);
    const b = planReconnect(3, policy, () => 0.75);
    expect(a).not.toEqual(b);
  });

  it("gives up after maxAttempts so the learner degrades to batch instead of waiting forever", () => {
    expect(planReconnect(policy.maxAttempts, policy, () => 1).action).toBe("retry");
    expect(planReconnect(policy.maxAttempts + 1, policy, () => 1)).toEqual({
      action: "give-up",
      reason: "max-attempts",
    });
  });

  it("ships a sane default policy", () => {
    expect(DEFAULT_RECONNECT_POLICY.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_RECONNECT_POLICY.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_RECONNECT_POLICY.maxDelayMs).toBeGreaterThanOrEqual(
      DEFAULT_RECONNECT_POLICY.baseDelayMs,
    );
  });
});

describe("pushBoundedDropOldest", () => {
  it("keeps the buffer within max and reports nothing dropped while it fits", () => {
    const buf: number[] = [];
    expect(pushBoundedDropOldest(buf, 1, 3)).toBe(0);
    expect(pushBoundedDropOldest(buf, 2, 3)).toBe(0);
    expect(pushBoundedDropOldest(buf, 3, 3)).toBe(0);
    expect(buf).toEqual([1, 2, 3]);
  });

  it("drops the OLDEST item once full, keeping the most recent audio", () => {
    // On resume the newest audio is what the learner is reciting now; 60s-old audio is worth less.
    const buf = [1, 2, 3];
    expect(pushBoundedDropOldest(buf, 4, 3)).toBe(1);
    expect(buf).toEqual([2, 3, 4]);
  });

  it("stays bounded across a long outage (memory cannot grow without limit)", () => {
    const buf: number[] = [];
    let dropped = 0;
    for (let i = 0; i < 1000; i++) dropped += pushBoundedDropOldest(buf, i, 50);
    expect(buf).toHaveLength(50);
    expect(buf[buf.length - 1]).toBe(999); // newest retained
    expect(dropped).toBe(950); // and every loss is counted, not silent
  });

  it("treats max<=0 as buffering disabled — the item is dropped, not stored", () => {
    const buf: number[] = [];
    expect(pushBoundedDropOldest(buf, 1, 0)).toBe(1);
    expect(buf).toEqual([]);
  });
});

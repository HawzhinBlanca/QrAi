import { describe, expect, it } from "vitest";

import {
  canShowLearnerFacingAnswer,
  getLanguageDirection,
  requiresHumanReview,
} from "./platform";

/**
 * `lib/platform.ts` had no test. Two of its five exports are safety-critical.
 *
 * ── The gap that matters ────────────────────────────────────────────────────────────────────────
 * `canShowLearnerFacingAnswer` is the client-side learner gate for agent runs. It is NOT the same
 * function as `canShowLearnerFacingAiOutput` in @quran-ai/contracts — it wraps it, and adds one
 * thing:
 *
 *     if (agentRun.status === "blocked") return false;
 *
 * That line is load-bearing, because the contract gate never looks at `status` at all: it reads
 * only `reviewStatus`, `confidence` and `sources`. So a run that is BLOCKED but was previously
 * teacher-reviewed, is high-confidence and carries sources passes the contract gate outright. The
 * early return is the only thing standing between that run and a learner, and nothing exercised it.
 *
 * `blocked` is not a hypothetical combination — it is what happens when something already reviewed
 * is later withdrawn. The review status stays as the historical record; the status becomes blocked.
 *
 * Not covered here, deliberately: `formatPercent` and `summarizeScholarQueue` are presentation
 * helpers that make no safety guarantee. Testing them would pad the file without adding evidence.
 */

/** A run that clears every bar the contract gate checks. The gate's happy path. */
const clearedRun = {
  status: "approved" as const,
  reviewStatus: "teacher-reviewed" as const,
  confidence: 0.95,
  sources: [{ id: "s1", title: "Tajweed reference", citation: "Rule 1" }],
};

describe("canShowLearnerFacingAnswer — the client-side learner gate", () => {
  it("shows a run that genuinely cleared review", () => {
    // The control, and it is not optional: without it every assertion below is satisfied by a
    // function hardcoded to `false`, which would hide all legitimate feedback and look like a
    // perfectly passing test suite.
    expect(canShowLearnerFacingAnswer(clearedRun)).toBe(true);
  });

  it("withholds a BLOCKED run that would otherwise pass every other check", () => {
    // THE test. Same run as above in every respect except `status`. The contract gate returns true
    // for this input — verified by the sibling assertion below — so if the early return in
    // `canShowLearnerFacingAnswer` is removed, a withdrawn answer reaches a learner and nothing
    // else in the client stops it.
    expect(canShowLearnerFacingAnswer({ ...clearedRun, status: "blocked" })).toBe(false);
  });

  it("the blocked check is doing real work — the underlying contract gate would say yes", async () => {
    // Pins WHY the line above matters rather than just asserting the outcome. If the contract gate
    // ever starts rejecting blocked runs on its own, this goes red and whoever sees it can retire
    // the wrapper deliberately instead of discovering the duplication years later.
    const { canShowLearnerFacingAiOutput } = await import("@quran-ai/contracts");
    // Its parameter type does not even INCLUDE `status` — which is exactly the point: it cannot
    // refuse a blocked run, because it never sees that field.
    const { reviewStatus, confidence, sources } = clearedRun;
    expect(canShowLearnerFacingAiOutput({ reviewStatus, confidence, sources })).toBe(true);
  });

  it("still defers to the contract gate for everything it already refuses", () => {
    // The wrapper must ADD a refusal, never replace one. An implementation that only checked
    // `status` would pass the two tests above and let unreviewed, unsourced, low-confidence output
    // straight through.
    expect(canShowLearnerFacingAnswer({ ...clearedRun, reviewStatus: "ai-suggested" })).toBe(false);
    expect(canShowLearnerFacingAnswer({ ...clearedRun, confidence: 0.5 })).toBe(false);
    expect(canShowLearnerFacingAnswer({ ...clearedRun, sources: [] })).toBe(false);
  });
});

describe("requiresHumanReview", () => {
  it("does not require review for a fully cleared run", () => {
    expect(requiresHumanReview(clearedRun)).toBe(false);
  });

  it("requires review on each trigger independently", () => {
    // Asserted one at a time: an implementation that ORed the wrong pair, or dropped one condition,
    // still passes a test that changes several fields at once.
    expect(requiresHumanReview({ ...clearedRun, status: "needs-human-review" })).toBe(true);
    expect(requiresHumanReview({ ...clearedRun, reviewStatus: "ai-suggested" })).toBe(true);
    expect(requiresHumanReview({ ...clearedRun, reviewStatus: "teacher-review-required" })).toBe(true);
    expect(requiresHumanReview({ ...clearedRun, confidence: 0.81 })).toBe(true);
  });

  it("treats 0.82 as clearing the bar, not failing it", () => {
    // The boundary is `< 0.82`. Off-by-one here sends every borderline run to a human forever, or
    // none of them — and no other test in the repository pins which side 0.82 falls on.
    expect(requiresHumanReview({ ...clearedRun, confidence: 0.82 })).toBe(false);
    expect(requiresHumanReview({ ...clearedRun, confidence: 0.8199 })).toBe(true);
  });
});

describe("getLanguageDirection", () => {
  it("returns rtl for every right-to-left language the app offers", () => {
    // Getting this wrong renders Arabic — including canonical Quran text — left to right. It is the
    // single call that decides that, and it had no test.
    for (const language of ["ar", "ckb", "ur"] as const) {
      expect(getLanguageDirection(language), `${language} must be rtl`).toBe("rtl");
    }
  });

  it("returns ltr for English", () => {
    expect(getLanguageDirection("en")).toBe("ltr");
  });
});

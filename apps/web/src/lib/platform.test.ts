import { describe, expect, it } from "vitest";

import { canShowLearnerFacingAnswer, requiresHumanReview } from "./platform";

/**
 * `lib/platform.ts` had no test. Two of its four exports are safety-critical.
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

describe("requiresHumanReview — an ALLOWLIST, like every other implementation of this rule", () => {
  // This function was the only denylist among ~8 implementations of "is this safe to show", every
  // other one carrying a comment explaining that a denylist FAILS OPEN. It read:
  //
  //     status === "needs-human-review" || reviewStatus === "ai-suggested" ||
  //     reviewStatus === "teacher-review-required" || confidence < 0.82
  //
  // It also carried the repository's tenth copy of the 0.82 constant.
  //
  // It was not a content hole — the ternary in PlatformCommand falls through to
  // `canShowLearnerFacingAnswer`, which is a correct allowlist, so an unknown status still showed
  // "blocked" rather than "safe". What it produced was WRONG LABELS on a staff console, in the
  // direction of understating that a human is needed.

  it("fails CLOSED on a reviewStatus nobody has heard of", () => {
    // The denylist answered `false` here — "no human needed" — for a status it had never seen. A
    // typo, or a status added server-side without updating this file, read as settled.
    expect(requiresHumanReview({ ...clearedRun, reviewStatus: "under-review" as never })).toBe(true);
    expect(requiresHumanReview({ ...clearedRun, reviewStatus: "" as never })).toBe(true);
  });

  it("a run approved and confident but with NO source still needs a human", () => {
    // It cannot be shown (the contract gate requires a source) and it is not blocked — somebody has
    // to add the source. The denylist said `false`, so the console labelled it "blocked": a dead end
    // rather than a task. handlers/review.rs refuses this exact case with "reject it, or have a
    // source added first", which is a human action.
    expect(requiresHumanReview({ ...clearedRun, sources: [] })).toBe(true);
  });

  it("a BLOCKED run is never reported as awaiting review", () => {
    // Blocked is a decision, not a queue. The denylist returned `true` for a blocked run whenever
    // its confidence was under the bar, so a withdrawn answer showed up as work for a teacher.
    expect(requiresHumanReview({ ...clearedRun, status: "blocked", confidence: 0.5 })).toBe(false);
    expect(requiresHumanReview({ ...clearedRun, status: "blocked" })).toBe(false);
  });

  it("does not keep its own copy of the confidence floor", async () => {
    // 0.82 already lives in ~10 places. This file no longer needs to be one of them: it defers to
    // the contract gate, which owns the number. A literal reappearing here is the drift starting.
    //
    // Comments are stripped before the check, deliberately. The doc comment on `requiresHumanReview`
    // QUOTES the old denylist, 0.82 and all, because that is the clearest way to record what changed
    // — and the first version of this test failed on its own documentation. A source assertion that
    // cannot tell code from prose is not checking what it claims to.
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./platform.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/0\.82/);
    // The strip must not have eaten everything — otherwise the assertion above is vacuous.
    expect(code).toMatch(/export function requiresHumanReview/);
  });
});

import { describe, expect, it } from "vitest";

import { learnerVisibleTajweedFindings, tajweedReviewBadge } from "./tajweedReview";
import type { TajweedFinding } from "./api";

const base: TajweedFinding = {
  wordId: "1:1:1",
  rule: "ghunnah",
  arabicName: "غنة",
  category: "ghunnah",
  severity: "warning",
  explanation: "Hold the nasalization.",
  confidence: 0.9,
  reviewStatus: "ai-suggested",
  sources: [{ id: "s1", title: "Ref", citation: "Ref, p. 1" }],
};

describe("tajweed review badge", () => {
  it("labels live AI output (ai-suggested) as provisional, never verified", () => {
    const badge = tajweedReviewBadge(base);
    expect(badge.verified).toBe(false);
    expect(badge.labelKey).toBe("tajweedPanel.aiSuggestion");
  });

  it("labels teacher-reviewed, confident, sourced findings as verified", () => {
    const badge = tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed" });
    expect(badge.verified).toBe(true);
    expect(badge.labelKey).toBe("tajweedPanel.verified");
  });

  it("stays provisional when a reviewed finding lacks sources or confidence (the platform gate)", () => {
    expect(tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed", sources: [] }).verified).toBe(false);
    expect(tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed", confidence: 0.5 }).verified).toBe(false);
  });

  it("ensures that any unapproved/withheld rule (e.g. mushaddad-ghunnah) that is only 'ai-suggested' is strictly provisional", () => {
    const unapprovedFinding = {
      ...base,
      rule: "mushaddad-ghunnah",
      reviewStatus: "ai-suggested" as const
    };
    const badge = tajweedReviewBadge(unapprovedFinding);
    expect(badge.verified).toBe(false);
    expect(badge.labelKey).toBe("tajweedPanel.aiSuggestion");
  });

  it("withholds unreviewed or unsourced findings from the learner surface", () => {
    const visible = learnerVisibleTajweedFindings([
      { ...base, reviewStatus: "ai-suggested" },
      { ...base, reviewStatus: "teacher-review-required" },
      { ...base, reviewStatus: "teacher-reviewed", sources: [] },
      { ...base, reviewStatus: "scholar-approved" },
    ]);

    expect(visible).toEqual([{ ...base, reviewStatus: "scholar-approved" }]);
  });
});

import { describe, expect, it } from "vitest";

import { tajweedReviewBadge } from "./tajweedReview";
import type { TajweedFinding } from "./api";

const base: Pick<TajweedFinding, "confidence" | "reviewStatus" | "sources"> = {
  confidence: 0.9,
  reviewStatus: "ai-suggested",
  sources: [{ id: "s1", title: "Ref", citation: "Ref, p. 1" }],
};

describe("tajweed review badge", () => {
  it("labels live AI output (ai-suggested) as provisional, never verified", () => {
    const badge = tajweedReviewBadge(base);
    expect(badge.verified).toBe(false);
    expect(badge.label).toMatch(/not yet reviewed/i);
  });

  it("labels teacher-reviewed, confident, sourced findings as verified", () => {
    const badge = tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed" });
    expect(badge.verified).toBe(true);
    expect(badge.label).toBe("Verified");
  });

  it("stays provisional when a reviewed finding lacks sources or confidence (the platform gate)", () => {
    expect(tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed", sources: [] }).verified).toBe(false);
    expect(tajweedReviewBadge({ ...base, reviewStatus: "teacher-reviewed", confidence: 0.5 }).verified).toBe(false);
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchMemorizationPlan } from "./platform";

// The backend returns nextReviewAt as a raw ISO 8601 timestamp (e.g.
// "2036-07-03T23:57:49.052403+00:00"). Regression guard: this used to be shown to the learner
// completely unformatted (LearnerHome.tsx's "Next review" field, CompletePanel.tsx's summary
// sentence) instead of a human-readable date.
describe("fetchMemorizationPlan date formatting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats nextReviewAt as a human-readable date, not the raw ISO timestamp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          learnerId: "learner-1",
          tenantId: "hikmah-pilot-erbil",
          totalSessions: 129,
          streak: 2,
          mastery: 1.0,
          nextReviewAt: "2036-07-03T23:57:49.052403+00:00",
        }),
      }),
    );

    const plan = await fetchMemorizationPlan("hikmah-pilot-erbil", "learner-1");

    expect(plan?.nextReviewAt).not.toContain("T");
    expect(plan?.nextReviewAt).not.toContain("052403");
    expect(plan?.nextReviewAt).toMatch(/2036/);
  });

  it("leaves nextReviewAt null when the backend has no next review, so callers can supply their own translated fallback", async () => {
    // Regression test: this used to bake the literal English string "Not scheduled" directly into
    // the data, which meant LearnerHome.tsx/CompletePanel.tsx's own `?? t(...)` i18n fallbacks for
    // this exact field could never actually fire (nextReviewAt was never null for them to catch).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          learnerId: "learner-2",
          tenantId: "hikmah-pilot-erbil",
          totalSessions: 0,
          streak: 0,
          mastery: 0,
          nextReviewAt: null,
        }),
      }),
    );

    const plan = await fetchMemorizationPlan("hikmah-pilot-erbil", "learner-2");
    expect(plan?.nextReviewAt).toBeNull();
  });
});

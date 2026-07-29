import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchMemorizationPlan,
  getSelectableInterfaceLanguages,
  localeCapabilities,
  type LocaleCapability,
} from "./platform";
import en from "../locales/en.json";

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

function reviewedSoraniCapability(reviewExpiresAt: string, reviewedAt = "2026-07-19"): LocaleCapability {
  return {
    code: "ckb",
    label: "Kurdish Sorani",
    nativeName: "کوردیی ناوەندی",
    direction: "rtl",
    interface: {
      availability: "available",
      source: "reviewed-translation",
      bundlePath: "apps/web/src/locales/ckb.json",
      keyCount: 378,
      reviewedBy: "Native-language reviewer",
      reviewedAt,
      reviewExpiresAt,
    },
    quranTranslation: {
      availability: "bounded-sourced",
      evidence: "Test-only sourced-verse capability.",
    },
  };
}

describe("locale capability expiry", () => {
  it("offers a reviewed translation only while its recorded review is current", () => {
    const now = new Date("2026-07-19T12:00:00.000Z");

    expect(getSelectableInterfaceLanguages([reviewedSoraniCapability("2026-07-19T11:59:59.000Z")], now)).toEqual([]);
    expect(getSelectableInterfaceLanguages([reviewedSoraniCapability("2026-07-19T12:00:01.000Z")], now).map((locale) => locale.code)).toEqual(["ckb"]);
    expect(getSelectableInterfaceLanguages([reviewedSoraniCapability("2026-07-20T12:00:00.000Z", "2026-07-20T00:00:00.000Z")], now)).toEqual([]);
  });

  it("keeps the source-language capability count aligned with the shipped English bundle", () => {
    const english = localeCapabilities.find((locale) => locale.code === "en");
    expect(english?.interface.availability).toBe("available");
    expect(english?.interface.source).toBe("source-language");
    if (!english || english.interface.source !== "source-language") return;

    const countLeaves = (value: Record<string, unknown>): number =>
      Object.values(value).reduce<number>(
        (count, child) => count + (typeof child === "object" && child !== null ? countLeaves(child as Record<string, unknown>) : 1),
        0,
      );

    expect(english.interface.keyCount).toBe(countLeaves(en));
  });
});

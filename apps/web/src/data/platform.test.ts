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

  it("never lets a locale advertise a bundle it does not have", async () => {
    // The invariant above is SOURCE-LANGUAGE ONLY: it early-returns unless
    // `source === "source-language"`, so it checks `en` and nothing else. Every other locale's
    // declared keyCount is unverified.
    //
    // That matters on exactly one day — the day someone ships a reviewed locale. Flipping `ckb` to
    // `availability: "available"` today is caught, but only by App.smoke's `toEqual(["en"])`, which
    // is a PIN on the current offer list. Whoever genuinely ships Sorani will update that pin (they
    // should), and at that moment nothing checks that `apps/web/src/locales/ckb.json` contains the
    // 384 strings the manifest claims. An empty bundle plus `fallbackLng: "en"` renders a fully
    // English app that the capability manifest insists is reviewed Kurdish — the manifest becomes
    // the thing it exists to prevent.
    //
    // Loaded dynamically because the set is data-driven: a locale added to the manifest tomorrow is
    // covered without touching this file.
    const countLeaves = (value: Record<string, unknown>): number =>
      Object.values(value).reduce<number>(
        (count, child) => count + (typeof child === "object" && child !== null ? countLeaves(child as Record<string, unknown>) : 1),
        0,
      );

    const declared = localeCapabilities.filter(
      (locale): locale is typeof locale & { interface: { bundlePath: string; keyCount: number } } =>
        "bundlePath" in locale.interface && "keyCount" in locale.interface,
    );
    expect(declared.length).toBeGreaterThan(0);

    for (const locale of declared) {
      const bundle = (await import(`../locales/${locale.code}.json`)).default as Record<string, unknown>;
      const actual = countLeaves(bundle);
      expect(
        actual,
        `${locale.code}: the manifest claims ${locale.interface.keyCount} reviewed strings, the bundle has ${actual}`,
      ).toBe(locale.interface.keyCount);
      expect(actual, `${locale.code}: an available locale with an empty bundle renders as English`).toBeGreaterThan(0);
    }
  });
});

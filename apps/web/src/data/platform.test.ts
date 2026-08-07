import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchBenchmarkMetrics,
  fetchEvalRun,
  fetchMemorizationPlan,
  getSelectableInterfaceLanguages,
  localeCapabilities,
  type LocaleCapability,
} from "./platform";
import en from "../locales/en.json";

describe("evaluation evidence fixtures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never turns browser smoke mode into a passing or release-eligible model claim", async () => {
    vi.stubGlobal("window", { location: { search: "?smoke" } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const run = await fetchEvalRun("hikmah-pilot-erbil", "model-v0.3");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      modelVersion: "model-v0.3",
      datasetVersion: "declared-browser-smoke-fixture-v1",
      evidenceKind: "legacy-aggregate",
      evidenceEligibility: "fixture-regression",
      releaseEligible: false,
      passed: false,
    });
    expect(run?.evidencePayload).toBeNull();
    expect(run?.signatureBase64Url).toBeNull();

    const metrics = await fetchBenchmarkMetrics("hikmah-pilot-erbil");
    expect(metrics).toHaveLength(5);
    expect(metrics.every((metric) => metric.status === "blocked")).toBe(true);
  });
});

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

describe("locale direction", () => {
  /**
   * Codepoint blocks whose scripts are written right-to-left: Hebrew, Arabic, Syriac, Arabic
   * Supplement, Thaana, Arabic Extended-A, and the Arabic Presentation Forms.
   *
   * Written as `\u` escapes rather than literal characters, per AGENTS.md — a literal Arabic range
   * in a source file is invisible to review, survives a bad copy-paste, and is the exact shape that
   * once deleted every Arabic letter from a regex (PR #258).
   */
  const RTL_SCRIPT =
    /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;

  it("declares a direction that matches each locale's own script", () => {
    // `App.tsx:382` sets `document.documentElement.dir` from this field, so it decides the reading
    // direction of the ENTIRE page — including canonical Quran text.
    //
    // `App.smoke` already asserts the wiring, but only for `de` (ltr) and `ckb` (rtl): two of the
    // nine locales, and only ones reachable through the visible picker. `ar` and `ur` are declared
    // rtl and nothing exercised either. Flipping `ar` to `ltr` — or adding a new Arabic-script
    // locale as ltr — would render Arabic left to right with every test still green.
    //
    // The expectation is DERIVED from `nativeName`'s script rather than compared against a second
    // hardcoded list. A parallel list is the same claim written twice: it drifts, and it has to be
    // updated by whoever adds a locale — which is precisely the person who just got it wrong. This
    // way a new locale is checked the moment it exists, with nothing to keep in sync.
    for (const locale of localeCapabilities) {
      const expected = RTL_SCRIPT.test(locale.nativeName) ? "rtl" : "ltr";
      expect(
        locale.direction,
        `${locale.code} (${locale.nativeName}) is written ${expected}, but the manifest declares ${locale.direction}`,
      ).toBe(expected);
    }
  });

  it("the script check can actually tell the two apart", () => {
    // Guard the guard. If `RTL_SCRIPT` were broken — an empty class, a range that matches
    // everything — the invariant above would still pass on today's data by agreeing with itself in
    // the wrong direction. These two pin that it discriminates at all.
    expect(RTL_SCRIPT.test("العربية"), "the Arabic-script probe must match Arabic").toBe(true);
    expect(RTL_SCRIPT.test("Deutsch"), "the Arabic-script probe must not match Latin").toBe(false);
  });

  it("covers every locale, so a new one cannot arrive unchecked", () => {
    // The invariant loops over whatever is in the manifest, so it silently checks nothing if the
    // manifest is empty or the field disappears. Both are cheap to rule out.
    expect(localeCapabilities.length).toBeGreaterThanOrEqual(9);
    for (const locale of localeCapabilities) {
      expect(["ltr", "rtl"], `${locale.code} has no usable direction`).toContain(locale.direction);
    }
  });
});

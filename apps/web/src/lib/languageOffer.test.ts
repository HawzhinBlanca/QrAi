import { describe, expect, it } from "vitest";

import { localeCapabilities, getSelectableInterfaceLanguages } from "../data/platform";
import { offersUnreviewedLanguages } from "./languageOffer";

/**
 * P2.3 — a production build may not offer a language the project declares unshipped.
 *
 * The predicate takes its environment as an argument precisely so this file can ask about a
 * PRODUCTION build. These tests run with `MODE === "test"`, so a predicate reading `import.meta.env`
 * directly could only ever be exercised in the mode that answers true — which is how the defect
 * survived: every existing test of the picker ran in the branch that offers everything.
 */
describe("offersUnreviewedLanguages", () => {
  it("refuses in a production build", () => {
    expect(offersUnreviewedLanguages({ MODE: "production" })).toBe(false);
  });

  it("allows the dev server, which is what every browser smoke runs", () => {
    // smoke-browser, smoke-a11y and smoke-e2e each spawn `vite`, so all three run with
    // MODE === "development" and keep the full list they select from.
    expect(offersUnreviewedLanguages({ MODE: "development" })).toBe(true);
  });

  it("fails CLOSED on a mode it has never heard of", () => {
    // `vite build --mode staging` is not production and not development. An allowlist gives it the
    // reviewed list; a denylist would have handed a staging deployment all nine.
    expect(offersUnreviewedLanguages({ MODE: "staging" })).toBe(false);
    expect(offersUnreviewedLanguages({ MODE: "" })).toBe(false);
  });

  it("allows the test runner", () => {
    expect(offersUnreviewedLanguages({ MODE: "test" })).toBe(true);
  });

  it("cannot be turned on from a URL", () => {
    // THE case. The old expression was
    //   MODE === "test" || new URLSearchParams(window.location.search).has("smoke")
    // whose second half is a runtime read that survives into the bundle — `has("smoke")` was
    // grepped straight out of the built PlatformCommand and LoginScreen chunks. Appending `?smoke`
    // to a deployed URL turned a one-option picker into a nine-option one.
    //
    // The predicate takes no request, no location and no search string, so there is nothing for a
    // URL to say. That is the fix, and this asserts the SHAPE of it rather than a behaviour, because
    // a signature that cannot see the query string cannot be talked into consulting it.
    expect(offersUnreviewedLanguages.length).toBe(1);

    const production = { MODE: "production" };
    // Whatever a caller does to the page, the answer is the same object in, same answer out.
    expect(offersUnreviewedLanguages(production)).toBe(false);
    expect(offersUnreviewedLanguages({ ...production })).toBe(false);
  });
});

describe("what a production build is therefore allowed to offer", () => {
  it("offers only locales declared available — one of nine today", () => {
    // Both halves matter. The count pins the claim ("eight languages were on offer that the project
    // says it does not ship"), and the availability check is what makes the count meaningful rather
    // than a number that drifts.
    const selectable = getSelectableInterfaceLanguages();
    expect(localeCapabilities.length).toBe(9);
    expect(selectable.map((locale) => locale.code)).toEqual(["en"]);

    const unshipped = localeCapabilities.filter(
      (locale) => locale.interface.availability === "unavailable",
    );
    expect(unshipped).toHaveLength(8);
    // Each one says so in as many words, which is what makes offering it a false claim rather than
    // an incomplete one.
    for (const locale of unshipped) {
      expect(locale.interface).toHaveProperty("evidence");
    }
  });

  it("every offered locale really has a bundle behind it", () => {
    // The other direction. A filter that returned everything would satisfy the test above only by
    // coincidence of today's data; this fails if `available` ever stops meaning "shipped".
    for (const offered of getSelectableInterfaceLanguages()) {
      const capability = localeCapabilities.find((locale) => locale.code === offered.code);
      expect(capability?.interface.availability).toBe("available");
    }
  });
});

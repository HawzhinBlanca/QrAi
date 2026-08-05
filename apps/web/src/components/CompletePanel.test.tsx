// @vitest-environment jsdom
//
// P2.6 / honesty: the panel that tells a learner whether their practice was saved.
//
// `CompletePanel.tsx:18` records that a previous version asserted "Progress saved." UNCONDITIONALLY
// — including when nothing had been recited, and when the write had failed. Telling someone their
// work was recorded when it was not is worse than showing them an error: they stop practising,
// believing it counted, and the loss is invisible until they notice their streak never moved.
//
// It was fixed by hand and nothing has checked it since. `SaveState` has four values and only ONE
// of them may make that claim.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../i18n";
import type { MemorizationPlan } from "../data/platform";
import en from "../locales/en.json";
import { CompletePanel, type SaveState } from "./CompletePanel";

/**
 * A fully typed plan rather than a cast.
 *
 * `as never` would have silenced the checker completely: if `MemorizationPlan` grew a field this
 * component came to depend on, the fixture would keep compiling and the test would keep passing
 * against a shape the app no longer uses. The point of these fixtures is to break when the contract
 * moves.
 */
const plan = (nextReviewAt: string | null): MemorizationPlan => ({
  learnerId: "learner-1",
  nextReviewAt,
  currentFocusKey: "focus.alFatihah",
  intervals: [],
});

/**
 * The claim under test, taken from the BUNDLE rather than retyped here.
 *
 * Hardcoding "Progress saved." would make this test a copy-editing tripwire — it would go red when
 * someone rewords the reassurance, which is not the guarantee. What must hold is that whatever
 * string means "saved" appears for exactly one state.
 */
const SAVED_BODY = en.completePanel.bodySaved;

const ALL_STATES: SaveState[] = ["idle", "saved", "nothing-recited", "failed"];

describe("CompletePanel — only a real save may claim a save", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (saveState: SaveState) => {
    act(() =>
      root.render(
        <CompletePanel
          onReset={() => {}}
          memorizationPlan={plan("Friday")}
          saveState={saveState}
        />,
      ),
    );
    return container.textContent ?? "";
  };

  it("says progress was saved when — and only when — it was", () => {
    // The control first: a component hardcoded to the honest message would satisfy every negative
    // assertion below while never telling a learner their work landed.
    expect(render("saved")).toContain("Progress saved");
  });

  it.each(["idle", "nothing-recited", "failed"] as const)(
    "does not claim a save in the %s state",
    (saveState) => {
      // The regression that actually happened. `idle` matters as much as the others: it is the
      // INITIAL value, so a learner who reaches this panel through the stepper without reciting
      // hits it, and the honest message must be the default rather than the reassuring one.
      const text = render(saveState);
      expect(text).not.toContain("Progress saved");
      expect(text.length, `the ${saveState} state rendered no body at all`).toBeGreaterThan(0);
    },
  );

  it("gives every state its own body, so none silently borrows another's meaning", () => {
    // `idle` and `nothing-recited` deliberately share one message — both mean "nothing was
    // recorded" — so this asserts the three distinct BODIES, not four. What must never happen is
    // `failed` or `saved` collapsing into another state's text.
    const bodies = new Map(ALL_STATES.map((s) => [s, render(s)]));
    expect(bodies.get("failed")).not.toBe(bodies.get("saved"));
    expect(bodies.get("failed")).not.toBe(bodies.get("nothing-recited"));
    expect(bodies.get("idle")).toBe(bodies.get("nothing-recited"));
  });

  it("never shows a learner a raw translation key or an unfilled placeholder", () => {
    // Two failures that look identical to a learner and neither of which any type check can see:
    // a missing translation echoes its key back, and rendering `bodySaved` without its parameter
    // leaves `{{nextReview}}` on screen verbatim.
    for (const saveState of ALL_STATES) {
      const text = render(saveState);
      expect(text, `${saveState} leaked an i18n key`).not.toMatch(/completePanel\./);
      expect(text, `${saveState} left a placeholder unfilled`).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("falls back to translated copy when there is no scheduled next review", () => {
    // `data/platform.ts:284` records that `nextReviewAt` was once typed non-nullable, which made
    // CompletePanel's `?? t("completePanel.nextReviewDefault")` DEAD CODE — it could never run.
    // The type was fixed; the fallback it exists for is exercised here for the first time.
    act(() =>
      root.render(
        <CompletePanel onReset={() => {}} memorizationPlan={plan(null)} saveState="saved" />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain(en.completePanel.nextReviewDefault);
    expect(text, "a null date reached the learner as text").not.toMatch(/null|undefined/);
  });

  it("interpolates the real next-review date into the saved message", () => {
    // Pins that `saved` is the branch that receives the parameter. Swapping which branch gets it is
    // invisible to the assertions above as long as the wording differs.
    expect(SAVED_BODY).toContain("{{nextReview}}");
    expect(render("saved")).toContain("Friday");
  });
});

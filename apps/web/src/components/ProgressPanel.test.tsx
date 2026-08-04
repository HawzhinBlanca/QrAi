// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { ProgressBar } from "../data/quran";
import { ProgressPanel } from "./ProgressPanel";

/**
 * The weekly chart when a day has NO MEASURED accuracy.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 * ADR-0030 made `accuracy` count only words the server itself transcribed, so a learner who
 * practises on the web — where the transcript is client-supplied — now gets `accuracy: null` for
 * every day. That is correct, and it turned a rare state into the common one.
 *
 * When that shipped, the claim "the chart already renders null as no-data, so nothing breaks" was
 * made from READING `ProgressPanel.tsx:83`. There was no test. A component whose most likely input
 * had never been rendered in a test is not "already handled", it is untried — and `null` reaching
 * recharts, `Intl`, or a translation interpolation is exactly where a blank panel or a thrown render
 * comes from.
 *
 * So: render it, and look.
 *
 * (The first version of this file passed an extra `label` on each entry. Vitest does not typecheck,
 * so all four tests went green against a shape `ProgressBar` does not have — `label` is DERIVED by
 * the component from `date` through `Intl.DateTimeFormat`, and the surplus field was simply ignored.
 * `tsc` caught it in the same gate run. A test that compiles is part of what a test asserting the
 * component's contract has to be.)
 */

const container = () => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
};

function render(weeklyProgress: ProgressBar[]) {
  const element = container();
  act(() => {
    createRoot(element).render(
      <ProgressPanel
        accuracy={0}
        correctWords={0}
        mistakes={0}
        recitations={3}
        streak={2}
        mastery={0.4}
        weeklyProgress={weeklyProgress}
      />,
    );
  });
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProgressPanel weekly chart", () => {
  it("renders a day with no measured accuracy without throwing, and says so in words", () => {
    // The post-ADR-0030 shape for a web-only learner: real sessions, no server-derived words.
    const element = render([
      { date: "2026-08-01", accuracy: null, sessions: 2 },
      { date: "2026-08-02", accuracy: null, sessions: 1 },
    ]);

    // The screen-reader list is the real text equivalent — the recharts SVG is aria-hidden, so if
    // this is empty a non-visual learner is told nothing at all.
    const entries = [...element.querySelectorAll("ul.sr-only li")].map((li) => li.textContent ?? "");
    expect(entries).toHaveLength(2);

    // Not the measured-accuracy sentence. The distinction is the entire point of ADR-0030: a day
    // with unmeasured practice must not be described the same way as a day measured at some number.
    for (const entry of entries) {
      expect(entry).not.toMatch(/\d+(\.\d+)?%/);
      expect(entry.trim()).not.toBe("");
    }

    // And it is NOT the empty state: the learner practised, and the panel must not imply otherwise.
    expect(element.querySelector(".chart-empty")).toBeNull();
  });

  it("still reports a measured day as a percentage", () => {
    // The other direction. A test that only proves null renders would also pass on a component that
    // rendered every day as "pending" — including days the server did measure.
    const element = render([{ date: "2026-08-01", accuracy: 66.7, sessions: 1 }]);
    const entries = [...element.querySelectorAll("ul.sr-only li")].map((li) => li.textContent ?? "");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/66\.7/);
  });

  it("shows the honest empty state when there are no practice days at all", () => {
    // Distinct from "practised, not measured". Collapsing the two would tell a learner who practised
    // that they did not.
    const element = render([]);
    expect(element.querySelector(".chart-empty")).not.toBeNull();
    expect(element.querySelectorAll("ul.sr-only li")).toHaveLength(0);
  });

  it("does not hand a null accuracy to the chart as a zero", () => {
    // The failure this guards is silent: recharts plots a missing `accuracy` as nothing, but a
    // component that "helpfully" coerced null to 0 before plotting would draw a bar at the floor —
    // a learner reading "you scored zero" on a day nobody measured. The sr-only list is the
    // assertion surface because the SVG itself is aria-hidden and not queryable as data.
    const element = render([{ date: "2026-08-01", accuracy: null, sessions: 4 }]);
    const text = element.querySelector("ul.sr-only li")?.textContent ?? "";
    expect(text).not.toMatch(/\b0(\.0)?%/);
  });
});

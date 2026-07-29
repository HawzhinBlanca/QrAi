// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { QuranVerse } from "../data/quran";
import { QuranReader } from "./QuranReader";

// T4 — specs/canonical-corpus-marks/plan.md
//
// Non-recited mushaf annotation must be VISIBLE (waqf signs are recitation guidance a reciter needs)
// but must not be a scored, tappable word. Before this change a sajdah mark was announced to a screen
// reader as "۩ Missed" — telling a learner they failed to recite a symbol that must never be recited.

const WAQF = String.fromCodePoint(0x06da);
const SAJDAH = String.fromCodePoint(0x06e9);

const verse: QuranVerse = {
  id: "2:2",
  verseNumber: 2,
  words: [
    { id: "2:2:1", text: "ذَٰلِكَ", status: "good" },
    { id: "2:2:2", text: WAQF, status: "missed" }, // a mark the old path would score
    { id: "2:2:3", text: "فِيهِ", status: "good" },
    { id: "2:2:4", text: SAJDAH, status: "mistake" },
  ],
};

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

const reader = () => (
  <QuranReader activeWordId="" selectedWordId="" verses={[verse]} onSelectWord={() => {}} />
);

describe("QuranReader — non-recited marks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders NO button for a mark, but does render one per real word", () => {
    const c = render(reader());
    const buttonTexts = Array.from(c.querySelectorAll("button")).map((b) => b.textContent);

    expect(buttonTexts).toContain("ذَٰلِكَ");
    expect(buttonTexts).toContain("فِيهِ");
    expect(buttonTexts).not.toContain(WAQF);
    expect(buttonTexts).not.toContain(SAJDAH);
  });

  it("still SHOWS the mark glyph — mushaf fidelity is preserved, not deleted", () => {
    const c = render(reader());
    expect(c.textContent).toContain(WAQF);
    expect(c.textContent).toContain(SAJDAH);
  });

  it("never announces a mark with a recitation status", () => {
    // The original defect's worst face, as a screen reader heard it.
    const c = render(reader());
    for (const el of Array.from(c.querySelectorAll("[aria-label]"))) {
      const label = el.getAttribute("aria-label") ?? "";
      if (label.includes(WAQF) || label.includes(SAJDAH)) {
        expect(label).not.toMatch(/Missed|Mistake|Good|Needs improvement/);
      }
    }
  });

  it("announces the mark as pause guidance rather than hiding it from a blind reciter", () => {
    const c = render(reader());
    const marks = Array.from(c.querySelectorAll(".waqf-mark"));
    expect(marks).toHaveLength(2);
    for (const m of marks) {
      expect(m.tagName).toBe("SPAN");
      expect(m.getAttribute("aria-label")).toBe("Pause mark — recitation guidance, not recited");
      expect(m.getAttribute("aria-hidden")).toBeNull(); // deliberately NOT hidden
      expect(m.className).not.toMatch(/status-/);
    }
  });

  it("has no serious/critical axe violations with marks present", async () => {
    const c = render(reader());
    const results = await axe.run(c, { rules: { "color-contrast": { enabled: false } } });
    const serious = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.help}`);
    expect(serious).toEqual([]);
  });
});

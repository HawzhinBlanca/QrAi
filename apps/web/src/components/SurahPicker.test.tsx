// @vitest-environment jsdom
//
// P2.6 (loading state) + P2.5 (screen-reader semantics) for the control a learner uses to choose
// what to recite.
//
// `SurahPicker.tsx:5` states the design: a native <select> "gives full keyboard + screen-reader
// support for free", and "before the list loads it shows the current selection as the sole
// (disabled) option so the control never appears empty."
//
// Both halves of that were unverified. The loading branch is one ternary — `surahs.length > 0 ?
// surahs : [selected]` — and deleting it renders an empty <select> with a `value` nothing matches,
// which a browser draws as a blank box. Nothing anywhere would have noticed.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { SurahInfo } from "../lib/api";
import { SurahPicker } from "./SurahPicker";

const AL_FATIHAH: SurahInfo = {
  surahNumber: 1,
  ayahCount: 7,
  name: "Al-Faatiha",
  translation: "The Opening",
};
const AL_BAQARAH: SurahInfo = { surahNumber: 2, ayahCount: 286, name: "Al-Baqara" };

describe("SurahPicker", () => {
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

  const render = (surahs: SurahInfo[], onSelect = () => {}) => {
    act(() =>
      root.render(<SurahPicker surahs={surahs} selected={AL_FATIHAH} onSelect={onSelect} />),
    );
    return container.querySelector("select") as HTMLSelectElement;
  };

  it("never shows an empty control while the list is still loading", () => {
    // THE guarantee the file's own comment makes. With the fallback removed the <select> has no
    // options at all and `value` matches nothing, so a learner opening the app before the surah
    // list arrives sees a blank box where their practice choice should be.
    const select = render([]);
    expect(select.options.length, "the picker rendered with no options at all").toBe(1);
    expect(select.options[0].textContent).toContain("Al-Faatiha");
    expect(select.value).toBe("1");
  });

  it("disables itself while loading, so nothing can be chosen from a list that is not there", () => {
    expect(render([]).disabled).toBe(true);
    // The control, and not optional: a permanently disabled picker satisfies the assertion above
    // while making the app unusable.
    expect(render([AL_FATIHAH, AL_BAQARAH]).disabled).toBe(false);
  });

  it("shows every surah once the list has loaded", () => {
    const select = render([AL_FATIHAH, AL_BAQARAH]);
    expect(select.options.length).toBe(2);
    expect(select.options[1].textContent).toContain("Al-Baqara");
  });

  it("has an accessible name a screen reader can announce", () => {
    // The <label for> / id pairing is the entire reason a native <select> was chosen here. Break
    // the association and the control is announced as an unlabelled combo box — the learner hears
    // "combo box, Al-Faatiha" with no idea what it selects.
    const select = render([AL_FATIHAH]);
    const label = container.querySelector("label");
    expect(label?.getAttribute("for")).toBe(select.id);
    expect(select.id.length, "the select has no id, so no label can point at it").toBeGreaterThan(0);
    expect(label?.textContent?.length).toBeGreaterThan(0);
  });

  it("renders canonical surah metadata verbatim, never through a translation lookup", () => {
    // AGENTS.md's canonical-text invariant. `name` and `translation` are Quran reference metadata
    // and are passed as INTERPOLATION VALUES — only the surrounding "{{number}}. {{name}}…"
    // structure is a translation key. A refactor that ran the name through `t()` would silently
    // substitute or blank it.
    const select = render([AL_FATIHAH]);
    const text = select.options[0].textContent ?? "";
    expect(text).toContain("Al-Faatiha");
    expect(text).toContain("The Opening");
    expect(text).toContain("7");
    expect(text, "an i18n key leaked into the option label").not.toMatch(/surahPicker\./);
    expect(text, "an interpolation placeholder was left unfilled").not.toMatch(/\{\{|\}\}/);
  });

  it("reports the surah the learner actually picked", () => {
    const onSelect = vi.fn();
    const select = render([AL_FATIHAH, AL_BAQARAH], onSelect);
    act(() => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual(AL_BAQARAH);
  });

  it("stays silent when the chosen value is not a surah it knows", () => {
    // `if (next) onSelect(next)` — without it, `onSelect(undefined)` reaches the caller and the
    // reader is asked to display a surah that does not exist. Reachable whenever the option list
    // and the loaded list disagree, which is exactly what the loading branch above creates.
    const onSelect = vi.fn();
    const select = render([AL_FATIHAH, AL_BAQARAH], onSelect);
    act(() => {
      select.value = "999";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

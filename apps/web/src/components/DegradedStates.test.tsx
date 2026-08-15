// @vitest-environment jsdom
//
// P2.6 — the degradation-matrix cells that had no test of their own.
//
// `docs/readiness/DEGRADED_STATES.md` is the list; this file fills the cells that existing tests did
// not already cover. Each one asserts the same property: the state is DISTINGUISHABLE from success
// and from the other failure modes, and where the learner can do something about it, there is a
// control that does it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import en from "../locales/en.json";
import { PrivacySettings } from "./PrivacySettings";
import { QuranReader } from "./QuranReader";
import { TeacherSurface } from "./TeacherSurface";
import type { QuranVerse } from "../data/quran";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
}

const VERSES: QuranVerse[] = [
  { id: "1:1", verseNumber: 1, words: [{ id: "1:1:1", text: "بِسْمِ", status: "good" }] },
];

describe("loading is announced, not just drawn", () => {
  it("QuranReader marks itself busy while a surah is being fetched", async () => {
    // A reader that simply shows nothing while loading is indistinguishable from a surah with no
    // words in it, and to a screen reader it is indistinguishable from a page that has stopped
    // responding. `aria-busy` is what makes the wait a state rather than a gap.
    await render(
      <QuranReader
        activeWordId=""
        selectedWordId=""
        verses={[]}
        onSelectWord={() => {}}
        isLoading
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("QuranReader is NOT busy once the verses are there", async () => {
    // The other direction: a permanently-busy reader is a permanently-loading page.
    await render(
      <QuranReader
        activeWordId="1:1:1"
        selectedWordId="1:1:1"
        verses={VERSES}
        onSelectWord={() => {}}
        isLoading={false}
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeFalsy();
  });
});

describe("the teacher queue distinguishes all three of its states", () => {
  it("loading, unavailable and empty are three different messages", async () => {
    // The whole point of the P2.6 row. Asserted as a set-of-three rather than one at a time,
    // because the defect was two of them collapsing into one.
    const messages = [
      en.teacherSurface.loadingQueue,
      en.teacherSurface.queueUnavailable,
      en.teacherSurface.noPending,
    ];
    expect(new Set(messages).size, "two of the three queue states share a message").toBe(3);
  });

  it("shows the loading message before the answer arrives, then stops", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/recitation-sessions") && !url.includes("/alignments")) return pending;
      return Promise.resolve(new Response(JSON.stringify([])));
    });

    await render(<TeacherSurface tenantId="hikmah-pilot-erbil" />);
    expect(container.textContent ?? "").toContain(en.teacherSurface.loadingQueue);

    await act(async () => {
      release(new Response(JSON.stringify([])));
      await pending;
    });

    const text = container.textContent ?? "";
    expect(text, "the loading message must clear once the answer arrives").not.toContain(
      en.teacherSurface.loadingQueue,
    );
    expect(text).toContain(en.teacherSurface.noPending);
  });
});

describe("privacy self-service says so when it cannot act", () => {
  it("a failed export is reported, not silently dropped", async () => {
    // A privacy control that appears to do nothing is worse than one that is absent: the learner
    // believes they have exercised a right they have not exercised.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    await render(
      <PrivacySettings tenantId="hikmah-pilot-erbil" userId="learner-1" authToken={undefined} />,
    );

    // Matched on the real label, read from the bundle. ("export" is not in it — the control reads
    // "See what data you hold about me", which is the plainer wording the privacy work chose.)
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === en.privacySettings.exportAction,
    );
    expect(button, "the privacy surface should offer an export control").toBeTruthy();

    await act(async () => button!.click());

    expect(
      container.textContent ?? "",
      "a failed export left the learner with no message — they believe they exercised a right they did not",
    ).toContain(en.privacySettings.exportError);
  });
});

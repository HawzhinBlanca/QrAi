// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AyahTimings } from "@quran-ai/quran-data";
import "../i18n"; // initialize i18next so useTranslation resolves real strings
import { QuranReader } from "./QuranReader";
import { recitingWordIdAt } from "../lib/wordTimings";
import type { QuranVerse } from "../data/quran";

// Al-Fatihah 1:1 timings (Al-Afasy), as ingested in T1: 4 words with a small gap between each.
const AYAH_1_1: AyahTimings = {
  ayah: 1,
  audioUrl: "Alafasy/mp3/001001.mp3",
  words: [
    { wordId: "1:1:1", startMs: 60, endMs: 610 },
    { wordId: "1:1:2", startMs: 620, endMs: 1310 },
    { wordId: "1:1:3", startMs: 1320, endMs: 2450 },
    { wordId: "1:1:4", startMs: 2460, endMs: 5970 },
  ],
};

describe("recitingWordIdAt (follow-along logic)", () => {
  it("returns null before the first word begins", () => {
    expect(recitingWordIdAt(AYAH_1_1, 0)).toBeNull();
    expect(recitingWordIdAt(AYAH_1_1, 59)).toBeNull();
  });

  it("returns the word whose segment contains the time", () => {
    expect(recitingWordIdAt(AYAH_1_1, 300)).toBe("1:1:1");
    expect(recitingWordIdAt(AYAH_1_1, 900)).toBe("1:1:2");
    expect(recitingWordIdAt(AYAH_1_1, 2000)).toBe("1:1:3");
    expect(recitingWordIdAt(AYAH_1_1, 3000)).toBe("1:1:4");
  });

  it("holds the current word through the brief inter-word gap (no flicker to null)", () => {
    // 615ms is between word 1 (ends 610) and word 2 (starts 620): stay on word 1.
    expect(recitingWordIdAt(AYAH_1_1, 615)).toBe("1:1:1");
  });

  it("keeps the last word past its end until playback stops (silence tail)", () => {
    expect(recitingWordIdAt(AYAH_1_1, 6500)).toBe("1:1:4");
  });

  it("degrades safely for an ayah with no timing data", () => {
    expect(recitingWordIdAt(null, 1000)).toBeNull();
    expect(recitingWordIdAt({ ayah: 1, audioUrl: "x", words: [] }, 1000)).toBeNull();
  });
});

function renderReader(recitingWordId: string | null) {
  const verses: QuranVerse[] = [
    {
      id: "1:1",
      verseNumber: 1,
      words: [
        { id: "1:1:1", text: "بِسْمِ", status: "good" },
        { id: "1:1:2", text: "ٱللَّهِ", status: "good" },
        { id: "1:1:3", text: "ٱلرَّحْمَٰنِ", status: "good" },
        { id: "1:1:4", text: "ٱلرَّحِيمِ", status: "good" },
      ],
    },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QuranReader
        activeWordId=""
        selectedWordId=""
        onSelectWord={() => {}}
        verses={verses}
        recitingWordId={recitingWordId}
        recitationAttribution="Recitation: Test Reciter. Audio & word timings via Quran.com."
      />,
    );
  });
  return { container, root };
}

describe("QuranReader word highlight (DOM)", () => {
  const mounted: Array<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> = [];
  afterEach(() => {
    for (const m of mounted) {
      act(() => m.root.unmount());
      m.container.remove();
    }
    mounted.length = 0;
  });

  it("marks exactly the reciting word with .is-reciting", () => {
    const r = renderReader("1:1:3");
    mounted.push(r);
    const reciting = r.container.querySelectorAll(".word-token.is-reciting");
    expect(reciting).toHaveLength(1);
    expect(reciting[0].textContent).toBe("ٱلرَّحْمَٰنِ");
    expect(reciting[0].getAttribute("data-reciting")).toBe("true");
  });

  it("highlights no word when there is no reciting word (verse-level fallback)", () => {
    const r = renderReader(null);
    mounted.push(r);
    expect(r.container.querySelectorAll(".word-token.is-reciting")).toHaveLength(0);
    // attribution still renders (audio in use), words still present
    expect(r.container.querySelectorAll(".word-token")).toHaveLength(4);
    expect(r.container.querySelector(".reader-attribution")?.textContent).toContain("Quran.com");
  });
});

function renderReaderWithTranslation(showTranslation: boolean, translation: Map<number, string>) {
  const verses: QuranVerse[] = [
    { id: "1:1", verseNumber: 1, words: [{ id: "1:1:1", text: "بِسْمِ", status: "good" }] },
    { id: "1:2", verseNumber: 2, words: [{ id: "1:2:1", text: "ٱلْحَمْدُ", status: "good" }] },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QuranReader
        activeWordId=""
        selectedWordId=""
        onSelectWord={() => {}}
        verses={verses}
        translationByAyah={translation}
        translationAttribution="Burhan Muhammad-Amin (Tafsiri Asan) — via QuranEnc.com"
        showTranslation={showTranslation}
        onToggleTranslation={() => {}}
      />,
    );
  });
  return { container, root };
}

describe("QuranReader Sorani translation", () => {
  const mounted: Array<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> = [];
  afterEach(() => {
    for (const m of mounted) {
      act(() => m.root.unmount());
      m.container.remove();
    }
    mounted.length = 0;
  });

  const translation = new Map<number, string>([
    [1, "به ناوی خوای به‌خشنده‌ی میهره‌بان"],
    // ayah 2 deliberately absent → must render nothing for it (honest missing state)
  ]);

  it("renders the verbatim translation line (RTL, ckb) for ayahs that have one, and nothing for those that don't", () => {
    const r = renderReaderWithTranslation(true, translation);
    mounted.push(r);
    const lines = r.container.querySelectorAll(".verse-translation");
    expect(lines).toHaveLength(1); // only ayah 1 has a translation
    expect(lines[0].getAttribute("dir")).toBe("rtl");
    expect(lines[0].getAttribute("lang")).toBe("ckb");
    expect(lines[0].textContent).toBe("به ناوی خوای به‌خشنده‌ی میهره‌بان");
    expect(r.container.querySelector(".reader-attribution")?.textContent).toContain("QuranEnc.com");
  });

  it("shows no translation lines when the toggle is off", () => {
    const r = renderReaderWithTranslation(false, translation);
    mounted.push(r);
    expect(r.container.querySelectorAll(".verse-translation")).toHaveLength(0);
    // the toggle control is still present (data exists)
    expect(r.container.querySelector(".translation-toggle")).not.toBeNull();
  });
});

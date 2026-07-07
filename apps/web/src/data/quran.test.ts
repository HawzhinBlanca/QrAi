import { afterEach, describe, it, expect, vi } from "vitest";
import type { AlignmentResult } from "../lib/api";
import type { QuranVerse } from "./quran";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchSurah: vi.fn().mockRejectedValue(new Error("network down")) };
});

const { updateVersesWithAlignment, loadSurahVerses, getQuranVerses, loadWeeklyProgress } = await import("./quran");

// The ML alignment service emits wordId in the form `${surah}:${ayah}:${wordIndex}` (1-indexed).
// `loadSurahVerses` builds one QuranVerse word per real word with the SAME id scheme, so the reader
// can apply per-word status. Regression guard: a single synthetic `${ayah.id}:0` word (the old bug)
// never matched any real alignment id, so the reader always rendered every ayah "good".
const align = (wordId: string, status: AlignmentResult["status"]): AlignmentResult => ({
  wordId,
  canonicalText: "",
  heardText: "",
  status,
  confidence: 1,
});

const verse = (): QuranVerse => ({
  id: "1:1",
  verseNumber: 1,
  words: [
    { id: "1:1:1", text: "بِسْمِ", status: "good" },
    { id: "1:1:2", text: "ٱللَّهِ", status: "good" },
    { id: "1:1:3", text: "ٱلرَّحْمَٰنِ", status: "good" },
  ],
});

describe("updateVersesWithAlignment word-id matching", () => {
  it("applies each word's real alignment status via the surah:ayah:wordIndex id", () => {
    const [updated] = updateVersesWithAlignment(
      [verse()],
      [align("1:1:1", "matched"), align("1:1:2", "misread"), align("1:1:3", "missed")],
    );
    expect(updated.words.map((w) => w.status)).toEqual(["good", "mistake", "missed"]);
  });

  it("reflects real mistakes on every word (the reader no longer shows a false 'all good')", () => {
    const [updated] = updateVersesWithAlignment(
      [verse()],
      [align("1:1:1", "misread"), align("1:1:2", "misread"), align("1:1:3", "misread")],
    );
    expect(updated.words.every((w) => w.status === "mistake")).toBe(true);
  });

  it("does not match a synthetic `${ayah}:0` id (the removed fallback) against real word ids", () => {
    // An alignment addressed to the old `:0` placeholder must NOT paint the real word 1.
    const [updated] = updateVersesWithAlignment([verse()], [align("1:1:0", "misread")]);
    expect(updated.words.map((w) => w.status)).toEqual(["good", "good", "good"]);
  });
});

describe("getQuranVerses fallback when the backend is unreachable", () => {
  it("still returns the static Al-Fatihah bundle after a failed loadSurahVerses, not []", async () => {
    // loadSurahVerses never rejects on a fetch failure — it catches internally and resolves to [].
    // The bug: its catch block used to set the module-level cachedSurah to [] too, and
    // getQuranVerses()'s `cachedSurah ?? staticVerses` only falls back on null/undefined — an
    // empty array is not nullish, so the static fallback never kicked in and every subsequent
    // getQuranVerses() call (including App.tsx's own recovery path) returned [] for the rest of
    // the session, leaving the reader permanently blank after one failed fetch.
    const verses = await loadSurahVerses(1);
    expect(verses).toEqual([]);

    const fallback = getQuranVerses();
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback[0].words.length).toBeGreaterThan(0);
  });
});

describe("loadWeeklyProgress caches per learner, not globally", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not leak one learner's weekly-accuracy bars to a different learner in the same session", async () => {
    // Login/logout is an in-SPA state change (see lib/auth.tsx), not a page reload, so a bare
    // module-level cache with no user key previously outlived the learner it was fetched for —
    // the NEXT learner to log in during the same page session saw the FIRST learner's cached
    // weekly accuracy, a real cross-user data leak on a shared/kiosk device.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mastery: 0.9 }) }),
    );
    const learnerA = await loadWeeklyProgress("hikmah-pilot-erbil", "learner-a");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mastery: 0.1 }) }),
    );
    const learnerB = await loadWeeklyProgress("hikmah-pilot-erbil", "learner-b");

    expect(learnerA[0].accuracy).not.toEqual(learnerB[0].accuracy);
    // And re-fetching learner A again still returns their own cached data, not learner B's.
    const learnerAAgain = await loadWeeklyProgress("hikmah-pilot-erbil", "learner-a");
    expect(learnerAAgain).toEqual(learnerA);
  });
});

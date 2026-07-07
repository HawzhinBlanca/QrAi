import { describe, it, expect, vi } from "vitest";
import type { AlignmentResult } from "../lib/api";
import type { QuranVerse } from "./quran";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchSurah: vi.fn().mockRejectedValue(new Error("network down")) };
});

const { updateVersesWithAlignment, loadSurahVerses, getQuranVerses } = await import("./quran");

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

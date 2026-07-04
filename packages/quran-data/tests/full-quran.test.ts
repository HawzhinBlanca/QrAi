import { describe, it, expect } from "vitest";
import {
  FULL_QURAN_MANIFEST as EXPORTED_FULL_QURAN_MANIFEST,
  getAyahText as getExportedAyahText,
  validateFullQuranData as validateExportedFullQuranData,
} from "@quran-ai/quran-data/full-quran";
import {
  getSurah,
  getAyah,
  getAyahRangeWords,
  getWordCount,
  getAyahText,
  listAllSurahs,
  validateFullQuranData,
  FULL_QURAN_MANIFEST,
  CANONICAL_AYAH_COUNTS,
  FULL_QURAN_CONTENT_SHA256,
  computeFullQuranContentHash,
  checkSurahIntegrity,
  validateFullQuranIntegrity,
  type FullQuranSurah,
} from "../src/full-quran";

describe("Full Quran data", () => {
  it("manifest has 114 surahs and 6236 ayahs", () => {
    expect(FULL_QURAN_MANIFEST.surahCount).toBe(114);
    expect(FULL_QURAN_MANIFEST.totalAyahs).toBe(6236);
  });

  it("exports the server-only full Quran module through the package boundary", () => {
    expect(EXPORTED_FULL_QURAN_MANIFEST.surahCount).toBe(114);
    expect(EXPORTED_FULL_QURAN_MANIFEST.totalAyahs).toBe(6236);
    expect(getExportedAyahText(112, 1)).toContain("قُلْ");
    expect(validateExportedFullQuranData()).toEqual({ isValid: true, errors: [] });
  }, 60000);

  // Reads + parses all 114 surah files (~41ms locally). Generous timeout so it doesn't
  // flake under heavy concurrent load (e.g. proof.sh running inside the smoke suite).
  it("validates all surah files match manifest counts", () => {
    const result = validateFullQuranData();
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  }, 60000);

  it("gets Al-Fatihah (surah 1) with 7 ayahs and 29 words", () => {
    const surah = getSurah(1);
    expect(surah.surahNumber).toBe(1);
    expect(surah.ayahs.length).toBe(7);
    expect(surah.totalWords).toBe(29);
  });

  it("gets An-Nas (surah 114) with 6 ayahs", () => {
    const surah = getSurah(114);
    expect(surah.surahNumber).toBe(114);
    expect(surah.ayahs.length).toBe(6);
  });

  it("gets Al-Baqarah (surah 2) with 286 ayahs", () => {
    const surah = getSurah(2);
    expect(surah.surahNumber).toBe(2);
    expect(surah.ayahs.length).toBe(286);
  });

  it("gets a specific ayah", () => {
    const ayah = getAyah(1, 1);
    expect(ayah.surahNumber).toBe(1);
    expect(ayah.ayahNumber).toBe(1);
    expect(ayah.text).toContain("بِسْمِ");
    expect(ayah.words.length).toBeGreaterThan(0);
  });

  it("gets ayah range words", () => {
    const ayahs = getAyahRangeWords(1, 1, 3);
    expect(ayahs.length).toBe(3);
    expect(ayahs[0].ayahNumber).toBe(1);
    expect(ayahs[2].ayahNumber).toBe(3);
  });

  it("gets word count for a range", () => {
    const count = getWordCount(1, 1, 7);
    expect(count).toBe(29);
  });

  it("lists all surahs from manifest", () => {
    const surahs = listAllSurahs();
    expect(surahs.length).toBe(114);
    expect(surahs[0].surahNumber).toBe(1);
    expect(surahs[113].surahNumber).toBe(114);
  });

  it("gets ayah text", () => {
    const text = getAyahText(112, 1);
    expect(text).toContain("قُلْ");
  });

  it("throws for invalid surah number", () => {
    expect(() => getSurah(0)).toThrow("Invalid surah number");
    expect(() => getSurah(115)).toThrow("Invalid surah number");
  });

  it("throws for invalid ayah number", () => {
    expect(() => getAyah(1, 99)).toThrow("not found");
  });

  it("has consistent word counts across surahs", () => {
    const surahs = listAllSurahs();
    let totalWords = 0;
    for (const entry of surahs) {
      const surah = getSurah(entry.surahNumber);
      expect(surah.totalWords).toBe(entry.wordCount);
      totalWords += surah.totalWords;
    }
    expect(totalWords).toBe(FULL_QURAN_MANIFEST.totalWords);
  });
});

describe("Full Quran integrity (independent ground truth)", () => {
  it("canonical ayah counts: 114 surahs summing to 6236, matching known surahs", () => {
    expect(Object.keys(CANONICAL_AYAH_COUNTS)).toHaveLength(114);
    expect(Object.values(CANONICAL_AYAH_COUNTS).reduce((a, b) => a + b, 0)).toBe(6236);
    expect(CANONICAL_AYAH_COUNTS[1]).toBe(7); // Al-Fatihah
    expect(CANONICAL_AYAH_COUNTS[2]).toBe(286); // Al-Baqarah
    expect(CANONICAL_AYAH_COUNTS[114]).toBe(6); // An-Nas
  });

  it("the bundled Quran passes deep integrity validation against canonical counts", () => {
    const result = validateFullQuranIntegrity();
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  }, 60000);

  it("the content checksum matches the pinned constant (drift tripwire)", () => {
    expect(computeFullQuranContentHash()).toBe(FULL_QURAN_CONTENT_SHA256);
  }, 60000);

  // --- negative tests: prove the per-surah checker actually has teeth ---
  const goodSurah = (): FullQuranSurah => ({
    id: "1",
    surahNumber: 1,
    name: "x",
    englishName: "x",
    englishNameTranslation: "x",
    revelationType: "Meccan",
    numberOfAyahs: 2,
    totalWords: 3,
    ayahs: [
      { surahNumber: 1, ayahNumber: 1, text: "a b", words: ["a", "b"], wordCount: 2 },
      { surahNumber: 1, ayahNumber: 2, text: "c", words: ["c"], wordCount: 1 },
    ],
  });

  it("accepts a well-formed surah", () => {
    expect(checkSurahIntegrity(goodSurah(), 1, 2)).toEqual([]);
  });

  it("catches a wrong canonical ayah count", () => {
    expect(checkSurahIntegrity(goodSurah(), 1, 3).join(";")).toMatch(/canonical count is 3/);
  });

  it("catches a surah loaded under the wrong surah number (same-ayah-count file mixup)", () => {
    // goodSurah() is surah 1; validating it as surah 67 (both would be a 30-ayah collision in reality)
    // must be caught by the surahNumber check, not slip through on ayah count alone.
    expect(checkSurahIntegrity(goodSurah(), 67, 2).join(";")).toMatch(/expected 67/);
  });

  it("catches a gap/reorder in ayah numbering", () => {
    const s = goodSurah();
    s.ayahs[1].ayahNumber = 3; // 1,3 instead of 1,2 — total count still 2, would slip a count-only check
    expect(checkSurahIntegrity(s, 1, 2).join(";")).toMatch(/numbered 3, expected 2/);
  });

  it("catches empty ayah text", () => {
    const s = goodSurah();
    s.ayahs[0].text = "   ";
    expect(checkSurahIntegrity(s, 1, 2).join(";")).toMatch(/empty ayah text/);
  });

  it("catches a words.length / wordCount mismatch", () => {
    const s = goodSurah();
    s.ayahs[0].wordCount = 5; // words array still has 2
    expect(checkSurahIntegrity(s, 1, 2).join(";")).toMatch(/2 words but wordCount=5/);
  });

  it("catches a totalWords mismatch", () => {
    const s = goodSurah();
    s.totalWords = 99;
    expect(checkSurahIntegrity(s, 1, 2).join(";")).toMatch(/totalWords=99/);
  });

  it("does NOT catch a structure-preserving ayah-content swap — that is the content hash's job", () => {
    // Swapping two ayahs' content as a unit (text+words+wordCount) while keeping their numbering
    // correct preserves every structural invariant, so the per-surah checker is (correctly) silent.
    // This documents the layering: the pinned FULL_QURAN_CONTENT_SHA256 is the backstop for this class.
    // (A duplicate-text detector is NOT viable — surahs like Ar-Rahman legitimately repeat an ayah.)
    const s = goodSurah();
    const [a0, a1] = s.ayahs;
    [a0.text, a1.text] = [a1.text, a0.text];
    [a0.words, a1.words] = [a1.words, a0.words];
    [a0.wordCount, a1.wordCount] = [a1.wordCount, a0.wordCount];
    expect(checkSurahIntegrity(s, 1, 2)).toEqual([]);
  });
});

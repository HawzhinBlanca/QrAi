import { describe, it, expect } from "vitest";
import {
  getSurah,
  getAyah,
  getAyahRangeWords,
  getWordCount,
  getAyahText,
  listAllSurahs,
  validateFullQuranData,
  FULL_QURAN_MANIFEST,
} from "../src/full-quran";

describe("Full Quran data", () => {
  it("manifest has 114 surahs and 6236 ayahs", () => {
    expect(FULL_QURAN_MANIFEST.surahCount).toBe(114);
    expect(FULL_QURAN_MANIFEST.totalAyahs).toBe(6236);
  });

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

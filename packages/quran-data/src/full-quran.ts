/**
 * Full Quran data module — provides access to all 114 surahs, 6236 ayahs.
 * Data is loaded from pre-fetched JSON files in src/data/full-quran/.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data", "full-quran");
const MANIFEST_PATH = join(DATA_DIR, "manifest.json");

const manifestData = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FullQuranManifest;

export interface FullQuranAyah {
  surahNumber: number;
  ayahNumber: number;
  text: string;
  words: string[];
  wordCount: number;
}

export interface FullQuranSurah {
  id: string;
  surahNumber: number;
  name: string;
  englishName: string;
  englishNameTranslation: string;
  revelationType: "Meccan" | "Medinan";
  numberOfAyahs: number;
  totalWords: number;
  ayahs: FullQuranAyah[];
}

export interface FullQuranManifest {
  source: string;
  edition: string;
  apiUrl: string;
  importVersion: string;
  surahCount: number;
  totalAyahs: number;
  totalWords: number;
  surahs: Array<{
    surahNumber: number;
    name: string;
    englishName: string;
    ayahCount: number;
    wordCount: number;
    filePath: string;
  }>;
}

export const FULL_QURAN_MANIFEST = manifestData as FullQuranManifest;
export const FULL_QURAN_IMPORT_VERSION = manifestData.importVersion;
export const FULL_QURAN_SOURCE = "alquran.cloud" as const;
export const FULL_QURAN_EDITION = "quran-uthmani" as const;

// Cache for lazily-loaded surahs
const surahCache = new Map<number, FullQuranSurah>();

/** Load a specific surah by number (1-114). */
export function getSurah(surahNumber: number): FullQuranSurah {
  if (surahNumber < 1 || surahNumber > 114) {
    throw new Error(`Invalid surah number: ${surahNumber}. Must be 1-114.`);
  }

  const cached = surahCache.get(surahNumber);
  if (cached) return cached;

  const fileName = `surah-${String(surahNumber).padStart(3, "0")}.json`;
  const filePath = join(DATA_DIR, fileName);
  const data = JSON.parse(readFileSync(filePath, "utf8")) as FullQuranSurah;
  surahCache.set(surahNumber, data);
  return data;
}

/** Get a specific ayah by surah and ayah number. */
export function getAyah(surahNumber: number, ayahNumber: number): FullQuranAyah {
  const surah = getSurah(surahNumber);
  const ayah = surah.ayahs.find((a) => a.ayahNumber === ayahNumber);
  if (!ayah) {
    throw new Error(`Ayah ${surahNumber}:${ayahNumber} not found.`);
  }
  return ayah;
}

/** Get all ayahs for a range within a surah. */
export function getAyahRangeWords(
  surahNumber: number,
  ayahStart: number,
  ayahEnd: number,
): FullQuranAyah[] {
  const surah = getSurah(surahNumber);
  return surah.ayahs.filter(
    (a) => a.ayahNumber >= ayahStart && a.ayahNumber <= ayahEnd,
  );
}

/** Get total word count for a surah range. */
export function getWordCount(surahNumber: number, ayahStart: number, ayahEnd: number): number {
  return getAyahRangeWords(surahNumber, ayahStart, ayahEnd).reduce(
    (sum, ayah) => sum + ayah.wordCount,
    0,
  );
}

/** List all surah metadata without loading full text. */
export function listAllSurahs(): FullQuranManifest["surahs"] {
  return manifestData.surahs;
}

/** Get the canonical text for a specific ayah. */
export function getAyahText(surahNumber: number, ayahNumber: number): string {
  return getAyah(surahNumber, ayahNumber).text;
}

/** Get all words for a specific ayah. */
export function getAyahWords(surahNumber: number, ayahNumber: number): string[] {
  return getAyah(surahNumber, ayahNumber).words;
}

/** Validate that the full Quran data is consistent with the manifest. */
export function validateFullQuranData(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifestData.surahCount !== 114) {
    errors.push(`Expected 114 surahs, manifest says ${manifestData.surahCount}.`);
  }

  if (manifestData.totalAyahs !== 6236) {
    errors.push(`Expected 6236 total ayahs, manifest says ${manifestData.totalAyahs}.`);
  }

  let actualTotalAyahs = 0;
  let actualTotalWords = 0;

  for (const entry of manifestData.surahs) {
    try {
      const surah = getSurah(entry.surahNumber);
      if (surah.ayahs.length !== entry.ayahCount) {
        errors.push(
          `Surah ${entry.surahNumber}: manifest says ${entry.ayahCount} ayahs, file has ${surah.ayahs.length}.`,
        );
      }
      if (surah.totalWords !== entry.wordCount) {
        errors.push(
          `Surah ${entry.surahNumber}: manifest says ${entry.wordCount} words, file has ${surah.totalWords}.`,
        );
      }
      actualTotalAyahs += surah.ayahs.length;
      actualTotalWords += surah.totalWords;
    } catch {
      errors.push(`Surah ${entry.surahNumber}: failed to load file.`);
    }
  }

  if (actualTotalAyahs !== manifestData.totalAyahs) {
    errors.push(
      `Total ayahs mismatch: manifest=${manifestData.totalAyahs}, actual=${actualTotalAyahs}.`,
    );
  }

  if (actualTotalWords !== manifestData.totalWords) {
    errors.push(
      `Total words mismatch: manifest=${manifestData.totalWords}, actual=${actualTotalWords}.`,
    );
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Full Quran data module — provides access to all 114 surahs, 6236 ayahs.
 * Data is loaded from pre-fetched JSON files in src/data/full-quran/.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_AYAH_COUNTS } from "./canonical-ayah-counts";

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

// Re-exported for backward compatibility — moved to its own dependency-free module (no node:fs/
// node:crypto) so browser-safe code (packages/quran-data/src/index.ts) can import it too, without
// pulling in this file's node:fs-based implementation. See canonical-ayah-counts.ts for the doc
// comment on why this table is independent ground truth.
export { CANONICAL_AYAH_COUNTS };

/**
 * SHA-256 over the bundled Quran text (`surah:ayah:text\n` for all 6236 ayahs, in order). Pinning the
 * checksum of the count/structure-validated data means any FUTURE drift or tampering in the data files
 * is detected. Regenerate DELIBERATELY (and review the diff) only when the source edition intentionally
 * changes: `node packages/quran-data/scripts/quran-content-hash.mjs`.
 */
export const FULL_QURAN_CONTENT_SHA256 =
  "7d47065915b6dc645f6f975cb0eb1ec3d8f121869e911de97c69700c3fb6df5f";

/**
 * SHA-256 of all ayah text serialized as `surah:ayah:text\n` in surah/ayah order (matches the pinned
 * constant and scripts/quran-content-hash.mjs). The `:`/`\n` delimiters assume ayah text contains
 * neither character — verified true for the bundled edition; a source change that violates it must
 * update both serializers together.
 */
export function computeFullQuranContentHash(): string {
  const hash = createHash("sha256");
  for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
    for (const ayah of getSurah(surahNumber).ayahs) {
      hash.update(`${ayah.surahNumber}:${ayah.ayahNumber}:${ayah.text}\n`);
    }
  }
  return hash.digest("hex");
}

/**
 * Structural integrity of ONE surah against its canonical ayah count. PURE (takes the surah as input),
 * so it is exhaustively testable on synthetic/corrupted input. Returns human-readable errors ([] = ok).
 */
export function checkSurahIntegrity(
  surah: FullQuranSurah,
  expectedSurahNumber: number,
  expectedAyahCount: number,
): string[] {
  const errors: string[] = [];
  const prefix = `Surah ${expectedSurahNumber}`;

  // The loaded surah must actually BE the one requested. Without this, a file mixup that swaps two
  // surahs sharing the same canonical ayah count (there are 24 such collision groups — e.g. 32/67/89
  // each have 30 ayahs) passes every other per-surah check and would be caught only by the global
  // content hash, with no localization.
  if (surah.surahNumber !== expectedSurahNumber) {
    errors.push(`${prefix}: surahNumber is ${surah.surahNumber}, expected ${expectedSurahNumber}.`);
  }
  if (surah.ayahs.length !== expectedAyahCount) {
    errors.push(`${prefix}: ${surah.ayahs.length} ayahs, canonical count is ${expectedAyahCount}.`);
  }
  if (surah.numberOfAyahs !== surah.ayahs.length) {
    errors.push(
      `${prefix}: numberOfAyahs=${surah.numberOfAyahs} but ${surah.ayahs.length} ayahs present.`,
    );
  }

  // Ayah numbers must be exactly 1..N, contiguous and in order — no gaps, duplicates, or reordering.
  surah.ayahs.forEach((ayah, i) => {
    if (ayah.ayahNumber !== i + 1) {
      errors.push(`${prefix}: ayah at index ${i} is numbered ${ayah.ayahNumber}, expected ${i + 1}.`);
    }
    if (ayah.surahNumber !== surah.surahNumber) {
      errors.push(
        `${prefix}:${ayah.ayahNumber}: surahNumber ${ayah.surahNumber} != ${surah.surahNumber}.`,
      );
    }
    if (typeof ayah.text !== "string" || ayah.text.trim().length === 0) {
      errors.push(`${prefix}:${ayah.ayahNumber}: empty ayah text.`);
    }
    if (ayah.words.length !== ayah.wordCount) {
      errors.push(
        `${prefix}:${ayah.ayahNumber}: ${ayah.words.length} words but wordCount=${ayah.wordCount}.`,
      );
    }
    if (ayah.words.some((w) => typeof w !== "string" || w.trim().length === 0)) {
      errors.push(`${prefix}:${ayah.ayahNumber}: contains an empty word.`);
    }
  });

  const wordSum = surah.ayahs.reduce((sum, a) => sum + a.wordCount, 0);
  if (wordSum !== surah.totalWords) {
    errors.push(`${prefix}: totalWords=${surah.totalWords} but ayah wordCounts sum to ${wordSum}.`);
  }

  return errors;
}

/**
 * DEEP integrity check of the full Quran bundle against INDEPENDENT ground truth — stronger than
 * validateFullQuranData's self-referential manifest comparison. Verifies: 114 surahs present with the
 * canonical Hafs ayah counts; per-surah structural invariants (contiguous ayah numbers, non-empty
 * text/words, word-count totals); and a pinned content checksum so future drift/tampering is caught.
 */
export function validateFullQuranIntegrity(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // The reference table itself must be complete and correct, or we cannot validate against it.
  const canonicalKeys = Object.keys(CANONICAL_AYAH_COUNTS);
  const canonicalSum = Object.values(CANONICAL_AYAH_COUNTS).reduce((a, b) => a + b, 0);
  if (canonicalKeys.length !== 114 || canonicalSum !== 6236) {
    errors.push(
      `Canonical ayah-count table is malformed (entries=${canonicalKeys.length}, sum=${canonicalSum}).`,
    );
    return { isValid: false, errors };
  }

  for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
    let surah: FullQuranSurah;
    try {
      surah = getSurah(surahNumber);
    } catch {
      errors.push(`Surah ${surahNumber}: failed to load.`);
      continue;
    }
    errors.push(...checkSurahIntegrity(surah, surahNumber, CANONICAL_AYAH_COUNTS[surahNumber]));
  }

  // Independent content checksum (runs regardless of the structural results above; the two error
  // lists combine). Catches text drift/tampering that PRESERVES structure — e.g. a swap of two
  // equal-length ayahs' content — which the per-surah structural checks cannot see.
  const actualHash = computeFullQuranContentHash();
  if (actualHash !== FULL_QURAN_CONTENT_SHA256) {
    errors.push(
      `Full Quran content checksum mismatch: expected ${FULL_QURAN_CONTENT_SHA256}, got ${actualHash}.`,
    );
  }

  return { isValid: errors.length === 0, errors };
}

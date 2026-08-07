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
const PROVENANCE_V1_PATH = join(DATA_DIR, "provenance-v1.json");
const PROVENANCE_V2_PATH = join(DATA_DIR, "provenance-v2.json");

const manifestData = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FullQuranManifest;
const provenanceV2Data = JSON.parse(
  readFileSync(PROVENANCE_V2_PATH, "utf8"),
) as FullQuranProvenanceV2;

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


export interface FullQuranProvenanceV2 {
  schemaVersion: 2;
  provenanceId: string;
  supersedes: {
    provenanceId: string;
    file: string;
    sha256: string;
  };
  canonicalSourceId: string;
  edition: {
    identifier: string;
    scriptType: string;
  };
  importVersion: string;
  integrity: {
    algorithm: string;
    encoding: string;
    lengthPrefix: string;
    recordFraming: string;
    recordOrder: string;
    domains: {
      ayahs: string;
      wordTokens: string;
    };
    ayahs: {
      fields: string[];
      count: number;
      sha256: string;
    };
    wordTokens: {
      fields: string[];
      count: number;
      sha256: string;
    };
    tokenization: {
      reconstruction: string;
      exceptions: Array<{ ref: string; preservedPrefix: string }>;
    };
  };
  seed: {
    generator: string;
    integrityPreflightRequired: boolean;
  };
}

export interface QuranIntegrityHashes {
  ayahCount: number;
  wordTokenCount: number;
  ayahSha256: string;
  wordTokenSha256: string;
}

export const FULL_QURAN_MANIFEST = manifestData as FullQuranManifest;
export const FULL_QURAN_PROVENANCE_V2 = provenanceV2Data as FullQuranProvenanceV2;
export const FULL_QURAN_IMPORT_VERSION = manifestData.importVersion;
export const FULL_QURAN_SOURCE = "alquran.cloud" as const;
export const FULL_QURAN_SOURCE_ID = "alquran-cloud" as const;
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


const LENGTH_PREFIX_BYTES = 8;
const AYAH_HASH_DOMAIN = "qrai.full-quran.ayahs.v1";
const WORD_TOKEN_HASH_DOMAIN = "qrai.full-quran.word-tokens.v1";

function lengthDelimitedUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  prefix.writeBigUInt64BE(BigInt(bytes.byteLength));
  return Buffer.concat([prefix, bytes]);
}

function updateLengthDelimitedRecord(
  hash: ReturnType<typeof createHash>,
  fields: readonly string[],
): void {
  const payload = Buffer.concat(fields.map((field) => lengthDelimitedUtf8(field)));
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  prefix.writeBigUInt64BE(BigInt(payload.byteLength));
  hash.update(prefix);
  hash.update(payload);
}

/**
 * Hash an explicit ordered collection of surahs without changing any string bytes.
 * Decimal coordinates are ASCII UTF-8 fields; Arabic text/token fields are UTF-8 exactly as supplied.
 */
export function computeQuranIntegrityHashes(
  surahs: Iterable<FullQuranSurah>,
): QuranIntegrityHashes {
  const ayahHash = createHash("sha256");
  const wordTokenHash = createHash("sha256");
  ayahHash.update(lengthDelimitedUtf8(AYAH_HASH_DOMAIN));
  wordTokenHash.update(lengthDelimitedUtf8(WORD_TOKEN_HASH_DOMAIN));

  let ayahCount = 0;
  let wordTokenCount = 0;

  for (const surah of surahs) {
    for (const ayah of surah.ayahs) {
      updateLengthDelimitedRecord(ayahHash, [
        String(ayah.surahNumber),
        String(ayah.ayahNumber),
        ayah.text,
      ]);
      ayahCount += 1;

      ayah.words.forEach((word, wordOffset) => {
        updateLengthDelimitedRecord(wordTokenHash, [
          String(ayah.surahNumber),
          String(ayah.ayahNumber),
          String(wordOffset + 1),
          word,
        ]);
        wordTokenCount += 1;
      });
    }
  }

  return {
    ayahCount,
    wordTokenCount,
    ayahSha256: ayahHash.digest("hex"),
    wordTokenSha256: wordTokenHash.digest("hex"),
  };
}

export function computeFullQuranIntegrityHashes(): QuranIntegrityHashes {
  const surahs: FullQuranSurah[] = [];
  for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
    surahs.push(getSurah(surahNumber));
  }
  return computeQuranIntegrityHashes(surahs);
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

  // Preserve the original delimiter-based drift tripwire for compatibility with its reviewed v1
  // provenance. The v2 hashes below add unambiguous framing and independently cover word tokens.
  const actualLegacyHash = computeFullQuranContentHash();
  if (actualLegacyHash !== FULL_QURAN_CONTENT_SHA256) {
    errors.push(
      `Full Quran content checksum mismatch: expected ${FULL_QURAN_CONTENT_SHA256}, got ${actualLegacyHash}.`,
    );
  }

  const provenance = FULL_QURAN_PROVENANCE_V2;
  const expectedAyahFields = ["surahNumber", "ayahNumber", "text"];
  const expectedWordTokenFields = ["surahNumber", "ayahNumber", "wordIndex", "text"];
  const metadataMatches =
    provenance.schemaVersion === 2 &&
    provenance.provenanceId === "full-quran-2026-06-26-provenance-v2" &&
    provenance.canonicalSourceId === FULL_QURAN_SOURCE_ID &&
    provenance.edition.identifier === FULL_QURAN_EDITION &&
    provenance.edition.scriptType === "uthmani" &&
    provenance.importVersion === FULL_QURAN_IMPORT_VERSION &&
    provenance.integrity.algorithm === "sha256" &&
    provenance.integrity.encoding === "utf8" &&
    provenance.integrity.lengthPrefix === "uint64be" &&
    provenance.integrity.recordFraming ===
      "length-prefixed-record-of-length-prefixed-fields" &&
    provenance.integrity.recordOrder ===
      "surah-ascending,ayah-ascending,word-index-ascending" &&
    provenance.integrity.domains.ayahs === AYAH_HASH_DOMAIN &&
    provenance.integrity.domains.wordTokens === WORD_TOKEN_HASH_DOMAIN &&
    JSON.stringify(provenance.integrity.ayahs.fields) === JSON.stringify(expectedAyahFields) &&
    JSON.stringify(provenance.integrity.wordTokens.fields) ===
      JSON.stringify(expectedWordTokenFields) &&
    provenance.seed.generator ===
      "packages/quran-data/scripts/write-full-quran-sql-seed.mjs" &&
    provenance.seed.integrityPreflightRequired === true;
  if (!metadataMatches) {
    errors.push("Full Quran provenance v2 framing/source/version metadata mismatch.");
  }

  const actualV1ManifestHash = createHash("sha256")
    .update(readFileSync(PROVENANCE_V1_PATH))
    .digest("hex");
  if (
    provenance.supersedes.provenanceId !== "full-quran-2026-06-26-provenance-v1" ||
    provenance.supersedes.file !== "provenance-v1.json" ||
    provenance.supersedes.sha256 !== actualV1ManifestHash
  ) {
    errors.push("Full Quran provenance v1 supersession checksum mismatch.");
  }

  const hashes = computeFullQuranIntegrityHashes();
  if (
    hashes.ayahCount !== provenance.integrity.ayahs.count ||
    hashes.ayahSha256 !== provenance.integrity.ayahs.sha256
  ) {
    errors.push(
      `Full Quran framed ayah checksum mismatch: expected ${provenance.integrity.ayahs.sha256}/${provenance.integrity.ayahs.count}, got ${hashes.ayahSha256}/${hashes.ayahCount}.`,
    );
  }
  if (
    hashes.wordTokenCount !== provenance.integrity.wordTokens.count ||
    hashes.wordTokenSha256 !== provenance.integrity.wordTokens.sha256
  ) {
    errors.push(
      `Full Quran framed word-token checksum mismatch: expected ${provenance.integrity.wordTokens.sha256}/${provenance.integrity.wordTokens.count}, got ${hashes.wordTokenSha256}/${hashes.wordTokenCount}.`,
    );
  }

  const reconstructionExceptions: Array<{ ref: string; preservedPrefix: string }> = [];
  for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
    const surah = getSurah(surahNumber);
    for (const ayah of surah.ayahs) {
      const reconstructed = ayah.words.join(" ");
      if (reconstructed === ayah.text) continue;
      if (ayah.text === `\uFEFF${reconstructed}`) {
        reconstructionExceptions.push({
          ref: `${ayah.surahNumber}:${ayah.ayahNumber}`,
          preservedPrefix: "U+FEFF",
        });
      } else {
        errors.push(
          `Surah ${ayah.surahNumber} ayah ${ayah.ayahNumber}: tokens do not reconstruct the stored ayah bytes.`,
        );
      }
    }
  }
  if (
    provenance.integrity.tokenization.reconstruction !==
      "join tokens with one U+0020 in stored order" ||
    JSON.stringify(reconstructionExceptions) !==
      JSON.stringify(provenance.integrity.tokenization.exceptions)
  ) {
    errors.push("Full Quran token reconstruction contract mismatch.");
  }

  return { isValid: errors.length === 0, errors };
}

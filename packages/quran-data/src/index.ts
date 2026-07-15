import {
  createCanonicalAyahChecksum,
  createCanonicalChecksum,
  verifyCanonicalAyah,
  verifyCanonicalWord,
  type CanonicalAyahRecord,
  type CanonicalSourceManifest,
  type CanonicalWordRecord,
  type QuranReference,
} from "@quran-ai/contracts";
import { FATIHAH_SEED, type SeedAyah } from "./fatihah";
import { CANONICAL_AYAH_COUNTS } from "./canonical-ayah-counts";

export { FATIHAH_SEED, type SeedAyah } from "./fatihah";

// Full Quran (114 surahs, 6236 ayahs)
// NOTE: full-quran.ts uses node:fs and is server-only.
// We export types here but NOT the implementation — browser imports
// would crash. Use dynamic import() in Node contexts: `const { getSurah } = await import('./full-quran')`
export type {
  FullQuranAyah,
  FullQuranSurah,
  FullQuranManifest,
} from "./full-quran";
import type { FullQuranSurah } from "./full-quran";

// Word-level audio-segment timings for reference recitations (server-only loader; the web app
// imports the JSON directly via its bundler). Types are safe to export everywhere.
export type {
  WordTiming,
  AyahTimings,
  ExcludedAyah,
  SurahTimings,
} from "./word-timings";

export const CANONICAL_IMPORT_VERSION = "2026-06-24-fatihah-seed-v1";

export const CANONICAL_SOURCE_MANIFESTS: CanonicalSourceManifest[] = [
  {
    id: "tanzil",
    title: "Tanzil Uthmani Quran Text",
    url: "https://tanzil.net/docs/",
    edition: "uthmani",
    scriptType: "uthmani",
    importVersion: CANONICAL_IMPORT_VERSION,
  },
  {
    id: "quran-foundation",
    title: "Quran Foundation Quran.com API",
    url: "https://api-docs.quran.foundation/",
    edition: "quran-foundation-uthmani",
    scriptType: "uthmani",
    importVersion: CANONICAL_IMPORT_VERSION,
  },
];

export interface CanonicalImportBundle {
  source: CanonicalSourceManifest;
  ayahs: readonly CanonicalAyahRecord[];
  words: readonly CanonicalWordRecord[];
}

export interface CanonicalImportValidation {
  isValid: boolean;
  ayahCount: number;
  wordCount: number;
  errors: string[];
}

export function buildFatihahImportBundle(sourceId: CanonicalSourceManifest["id"] = "tanzil"): CanonicalImportBundle {
  const source = getCanonicalSourceManifest(sourceId);
  const ayahs = FATIHAH_SEED.map((seedAyah) => buildCanonicalAyah(seedAyah, source));
  const words = FATIHAH_SEED.flatMap((seedAyah) => buildCanonicalWords(seedAyah, source));

  return freezeBundle({ source, ayahs, words });
}

/**
 * Build a checksummed CanonicalImportBundle for one full-Quran surah, using the SAME checksum
 * functions (createCanonicalChecksum/createCanonicalAyahChecksum, which verifyCanonicalWord/
 * verifyCanonicalAyah in @quran-ai/contracts can actually validate) as buildFatihahImportBundle —
 * closing the gap where the production seed-full-quran-to-db.sh script computed source_checksum
 * as a hash of the raw text alone, a format verifyCanonicalWord/verifyCanonicalAyah cannot
 * validate (see docs/DECISIONS.md). Pure and browser-safe: takes an already-loaded FullQuranSurah
 * (no node:fs); the caller is responsible for loading it (see full-quran.ts, server-only).
 */
export function buildFullQuranSurahBundle(
  surah: FullQuranSurah,
  sourceId: CanonicalSourceManifest["id"],
  importVersion: string,
): CanonicalImportBundle {
  const source = { ...getCanonicalSourceManifest(sourceId), importVersion };
  const seedAyahs: SeedAyah[] = surah.ayahs.map((ayah) => ({
    surahNumber: ayah.surahNumber,
    ayahNumber: ayah.ayahNumber,
    text: ayah.text,
    words: ayah.words,
  }));
  const ayahs = seedAyahs.map((seedAyah) => buildCanonicalAyah(seedAyah, source, surah.englishName));
  const words = seedAyahs.flatMap((seedAyah) => buildCanonicalWords(seedAyah, source, surah.englishName));

  return freezeBundle({ source, ayahs, words });
}

export function getCanonicalSourceManifest(sourceId: CanonicalSourceManifest["id"]): CanonicalSourceManifest {
  const source = CANONICAL_SOURCE_MANIFESTS.find((manifest) => manifest.id === sourceId);

  if (!source) {
    throw new Error(`Unknown canonical source: ${sourceId}`);
  }

  return source;
}

export function validateCanonicalImportBundle(bundle: CanonicalImportBundle): CanonicalImportValidation {
  const errors: string[] = [];
  
  let expectedWordCount = 0;
  const ayahCountsBySurah = new Map<number, number>();

  for (const ayah of bundle.ayahs) {
    const parts = ayah.id.split(":");
    const surahNum = parseInt(parts[0], 10);
    const ayahNum = parseInt(parts[1], 10);

    ayahCountsBySurah.set(surahNum, (ayahCountsBySurah.get(surahNum) ?? 0) + 1);

    const seedAyah = FATIHAH_SEED.find(
      (s) => s.surahNumber === surahNum && s.ayahNumber === ayahNum
    );

    if (seedAyah) {
      expectedWordCount += seedAyah.words.length;
    } else {
      expectedWordCount += ayah.wordCount;
    }
  }

  // CANONICAL_AYAH_COUNTS is INDEPENDENT ground truth (the established recitation tradition, not
  // derived from this bundle) -- this is what actually catches a bundle missing or duplicating
  // ayahs within a surah. The check this replaced incremented its "expected" count once per ayah
  // PRESENT in the bundle regardless of which branch ran, so it was always trivially equal to
  // bundle.ayahs.length by construction -- dead code that could never fail for any bundle.
  for (const [surahNum, count] of ayahCountsBySurah) {
    const canonicalCount = CANONICAL_AYAH_COUNTS[surahNum];
    if (canonicalCount === undefined) {
      errors.push(`Surah ${surahNum} is not a valid surah number (1-114).`);
    } else if (count !== canonicalCount) {
      errors.push(`Surah ${surahNum}: expected ${canonicalCount} ayahs (canonical), found ${count}.`);
    }
  }

  if (bundle.words.length !== expectedWordCount) {
    errors.push(`Expected ${expectedWordCount} words, found ${bundle.words.length}.`);
  }

  for (const ayah of bundle.ayahs) {
    if (!verifyCanonicalAyah(ayah)) {
      errors.push(`Invalid ayah checksum: ${ayah.id}.`);
    }
  }

  for (const word of bundle.words) {
    if (!verifyCanonicalWord(word)) {
      errors.push(`Invalid word checksum: ${word.id}.`);
    }
  }

  return {
    isValid: errors.length === 0,
    ayahCount: bundle.ayahs.length,
    wordCount: bundle.words.length,
    errors,
  };
}

export function toCanonicalSqlSeed(bundle: CanonicalImportBundle): string {
  const ayahValues = bundle.ayahs
    .map((ayah) =>
      [
        sqlString(ayah.id),
        ayah.quranRef.surahNumber,
        ayah.quranRef.ayahStart,
        sqlString(ayah.text),
        sqlString(ayah.sourceId),
        sqlString(ayah.edition),
        sqlString(ayah.scriptType),
        sqlString(ayah.importVersion),
        sqlString(ayah.sourceChecksum),
      ].join(", "),
    )
    .map((row) => `  (${row})`)
    .join(",\n");

  const wordValues = bundle.words
    .map((word) =>
      [
        sqlString(word.id),
        sqlString(word.ayahId),
        word.wordIndex,
        sqlString(word.text),
        sqlString(word.sourceChecksum),
      ].join(", "),
    )
    .map((row) => `  (${row})`)
    .join(",\n");

  // ON CONFLICT ... DO UPDATE (not DO NOTHING): re-running this seed against an already-seeded
  // database must actually correct a row's source_checksum, not silently skip it — the whole
  // reason this needs to be idempotent-and-self-healing is that any database seeded before the
  // checksum-format fix (docs/DECISIONS.md) has a canonical_words/canonical_ayahs row whose
  // stored checksum verifyCanonicalWord/verifyCanonicalAyah cannot validate. text_uthmani is
  // re-affirmed too (defensively; canonical Quran text is immutable per AGENTS.md, so it should
  // never actually differ) rather than left stale if it or the checksum-affecting metadata ever
  // legitimately changes (e.g. a new import_version).
  return [
    "insert into canonical_ayahs (id, surah_number, ayah_number, text_uthmani, source_id, edition, script_type, import_version, source_checksum) values",
    `${ayahValues}`,
    "on conflict (id) do update set",
    "  text_uthmani = excluded.text_uthmani,",
    "  source_id = excluded.source_id,",
    "  edition = excluded.edition,",
    "  script_type = excluded.script_type,",
    "  import_version = excluded.import_version,",
    "  source_checksum = excluded.source_checksum;",
    "",
    "insert into canonical_words (id, ayah_id, word_index, text_uthmani, source_checksum) values",
    `${wordValues}`,
    "on conflict (id) do update set",
    "  text_uthmani = excluded.text_uthmani,",
    "  source_checksum = excluded.source_checksum;",
  ].join("\n");
}

// `surahLabel` defaults to "Al-Fatihah" so buildFatihahImportBundle's existing checksums are
// byte-for-byte unchanged (the label is part of the hashed payload via QuranReference.display) —
// buildFullQuranSurahBundle below passes the real surah name for every other surah.
function buildCanonicalAyah(
  seedAyah: SeedAyah,
  source: CanonicalSourceManifest,
  surahLabel = "Al-Fatihah",
): CanonicalAyahRecord {
  const record = {
    id: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
    quranRef: createAyahReference(seedAyah, surahLabel),
    text: seedAyah.text,
    wordCount: seedAyah.words.length,
    sourceId: source.id,
    edition: source.edition,
    scriptType: source.scriptType,
    importVersion: source.importVersion,
  } satisfies Omit<CanonicalAyahRecord, "sourceChecksum">;

  return Object.freeze({
    ...record,
    sourceChecksum: createCanonicalAyahChecksum(record),
  });
}

function buildCanonicalWords(
  seedAyah: SeedAyah,
  source: CanonicalSourceManifest,
  surahLabel = "Al-Fatihah",
): CanonicalWordRecord[] {
  return seedAyah.words.map((text, wordOffset) => {
    const wordIndex = wordOffset + 1;
    const record = {
      id: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}:${wordIndex}`,
      ayahId: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
      quranRef: createWordReference(seedAyah, wordIndex, surahLabel),
      wordIndex,
      text,
      sourceId: source.id,
      edition: source.edition,
      scriptType: source.scriptType,
      importVersion: source.importVersion,
    } satisfies Omit<CanonicalWordRecord, "sourceChecksum">;

    return Object.freeze({
      ...record,
      sourceChecksum: createCanonicalChecksum(record),
    });
  });
}

function createAyahReference(seedAyah: SeedAyah, surahLabel: string): QuranReference {
  return {
    surahNumber: seedAyah.surahNumber,
    ayahStart: seedAyah.ayahNumber,
    ayahEnd: seedAyah.ayahNumber,
    display: `${surahLabel} ${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
  };
}

function createWordReference(seedAyah: SeedAyah, wordIndex: number, surahLabel: string): QuranReference {
  return {
    ...createAyahReference(seedAyah, surahLabel),
    wordStart: wordIndex,
    wordEnd: wordIndex,
    display: `${surahLabel} ${seedAyah.surahNumber}:${seedAyah.ayahNumber}:${wordIndex}`,
  };
}

function freezeBundle(bundle: CanonicalImportBundle): CanonicalImportBundle {
  return Object.freeze({
    source: Object.freeze({ ...bundle.source }),
    ayahs: Object.freeze([...bundle.ayahs]),
    words: Object.freeze([...bundle.words]),
  });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

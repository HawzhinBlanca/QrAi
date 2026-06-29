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

export function getCanonicalSourceManifest(sourceId: CanonicalSourceManifest["id"]): CanonicalSourceManifest {
  const source = CANONICAL_SOURCE_MANIFESTS.find((manifest) => manifest.id === sourceId);

  if (!source) {
    throw new Error(`Unknown canonical source: ${sourceId}`);
  }

  return source;
}

export function validateCanonicalImportBundle(bundle: CanonicalImportBundle): CanonicalImportValidation {
  const errors: string[] = [];
  const expectedWordCount = FATIHAH_SEED.reduce((sum, ayah) => sum + ayah.words.length, 0);

  if (bundle.ayahs.length !== 7) {
    errors.push(`Expected 7 Al-Fatihah ayahs, found ${bundle.ayahs.length}.`);
  }

  if (bundle.words.length !== expectedWordCount) {
    errors.push(`Expected ${expectedWordCount} Al-Fatihah words, found ${bundle.words.length}.`);
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

  return [
    "insert into canonical_ayahs (id, surah_number, ayah_number, text_uthmani, source_id, edition, script_type, import_version, source_checksum) values",
    `${ayahValues};`,
    "",
    "insert into canonical_words (id, ayah_id, word_index, text_uthmani, source_checksum) values",
    `${wordValues};`,
  ].join("\n");
}

function buildCanonicalAyah(seedAyah: SeedAyah, source: CanonicalSourceManifest): CanonicalAyahRecord {
  const record = {
    id: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
    quranRef: createAyahReference(seedAyah),
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

function buildCanonicalWords(seedAyah: SeedAyah, source: CanonicalSourceManifest): CanonicalWordRecord[] {
  return seedAyah.words.map((text, wordOffset) => {
    const wordIndex = wordOffset + 1;
    const record = {
      id: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}:${wordIndex}`,
      ayahId: `${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
      quranRef: createWordReference(seedAyah, wordIndex),
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

function createAyahReference(seedAyah: SeedAyah): QuranReference {
  return {
    surahNumber: seedAyah.surahNumber,
    ayahStart: seedAyah.ayahNumber,
    ayahEnd: seedAyah.ayahNumber,
    display: `Al-Fatihah ${seedAyah.surahNumber}:${seedAyah.ayahNumber}`,
  };
}

function createWordReference(seedAyah: SeedAyah, wordIndex: number): QuranReference {
  return {
    ...createAyahReference(seedAyah),
    wordStart: wordIndex,
    wordEnd: wordIndex,
    display: `Al-Fatihah ${seedAyah.surahNumber}:${seedAyah.ayahNumber}:${wordIndex}`,
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

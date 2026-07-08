import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_SOURCE_MANIFESTS,
  buildFatihahImportBundle,
  toCanonicalSqlSeed,
  validateCanonicalImportBundle,
} from "../src";

describe("canonical Quran import", () => {
  it("builds immutable checksummed Al-Fatihah canonical records", () => {
    const bundle = buildFatihahImportBundle("tanzil");
    const validation = validateCanonicalImportBundle(bundle);

    expect(validation).toEqual({
      isValid: true,
      ayahCount: 7,
      wordCount: 29,
      errors: [],
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.ayahs[0])).toBe(true);
    expect(Object.isFrozen(bundle.words[0])).toBe(true);
    expect(bundle.ayahs[0]).toMatchObject({
      id: "1:1",
      text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
      wordCount: 4,
      sourceId: "tanzil",
      scriptType: "uthmani",
    });
    expect(bundle.words.at(-1)).toMatchObject({
      id: "1:7:9",
      ayahId: "1:7",
      text: "الضَّالِّينَ",
      wordIndex: 9,
    });
  });

  it("detects tampered canonical Quran word checksums", () => {
    const bundle = buildFatihahImportBundle("tanzil");
    const tamperedBundle = {
      ...bundle,
      words: [
        {
          ...bundle.words[0],
          text: "بسم",
        },
        ...bundle.words.slice(1),
      ],
    };

    const validation = validateCanonicalImportBundle(tamperedBundle);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain("Invalid word checksum: 1:1:1.");
  });

  it("detects a whole ayah dropped from the bundle, even though word/ayah counts stay self-consistent", () => {
    // Dropping ayah 1:7 (and its 9 words) keeps the bundle internally self-consistent -- the word
    // checksum check passes (no word was altered) and the OLD ayah-count check would also have
    // passed: it incremented its "expected" count once per ayah PRESENT in the bundle, so it was
    // always trivially equal to bundle.ayahs.length by construction, for any bundle. Only a check
    // against ayah-count ground truth INDEPENDENT of the bundle (CANONICAL_AYAH_COUNTS: Surah 1
    // has exactly 7 ayahs) can catch this.
    const bundle = buildFatihahImportBundle("tanzil");
    const droppedAyahBundle = {
      ...bundle,
      ayahs: bundle.ayahs.filter((ayah) => ayah.id !== "1:7"),
      words: bundle.words.filter((word) => word.ayahId !== "1:7"),
    };

    const validation = validateCanonicalImportBundle(droppedAyahBundle);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain("Surah 1: expected 7 ayahs (canonical), found 6.");
  });

  it("supports Tanzil and Quran Foundation source manifests without changing Arabic text", () => {
    const tanzilBundle = buildFatihahImportBundle("tanzil");
    const quranFoundationBundle = buildFatihahImportBundle("quran-foundation");

    expect(CANONICAL_SOURCE_MANIFESTS.map((source) => source.id)).toEqual(["tanzil", "quran-foundation"]);
    expect(quranFoundationBundle.ayahs.map((ayah) => ayah.text)).toEqual(tanzilBundle.ayahs.map((ayah) => ayah.text));
    expect(quranFoundationBundle.words.map((word) => word.text)).toEqual(tanzilBundle.words.map((word) => word.text));
    expect(quranFoundationBundle.words[0].sourceChecksum).not.toBe(tanzilBundle.words[0].sourceChecksum);
  });

  it("generates SQL seed output matching canonical schema columns", () => {
    const testDir = fileURLToPath(new URL(".", import.meta.url));
    const schema = readFileSync(resolve(testDir, "../../../infra/sql/0001_core_schema.sql"), "utf8");
    const sql = toCanonicalSqlSeed(buildFatihahImportBundle("tanzil"));

    expect(schema).toContain("create table canonical_ayahs");
    expect(schema).toContain("create table canonical_words");
    expect(schema).toContain("source_checksum text not null");
    expect(sql).toContain("insert into canonical_ayahs");
    expect(sql).toContain("insert into canonical_words");
    expect(sql).toContain("'1:7:9', '1:7', 9, 'الضَّالِّينَ'");
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const dataDir = join(repoRoot, "packages", "quran-data", "src", "data", "full-quran");
const fullQuranTs = readFileSync(join(repoRoot, "packages", "quran-data", "src", "full-quran.ts"), "utf8");

const EXPECTED_SURAHS = 114;
const EXPECTED_AYAHS = 6236;
const EXPECTED_WORDS = 82456;

// Extract content hash constant from source of truth
const hashMatch = fullQuranTs.match(/FULL_QURAN_CONTENT_SHA256\s*=\s*"([a-f0-9]{64})"/);
assert.ok(hashMatch, "FULL_QURAN_CONTENT_SHA256 must be defined in full-quran.ts");
const EXPECTED_CONTENT_HASH = hashMatch[1];

function computeCorpusHash(surahs) {
  const hash = createHash("sha256");
  for (const surah of surahs) {
    for (const ayah of surah.ayahs) {
      hash.update(`${ayah.surahNumber}:${ayah.ayahNumber}:${ayah.text}\n`);
    }
  }
  return hash.digest("hex");
}

function loadAllSurahs() {
  const surahs = [];
  for (let s = 1; s <= EXPECTED_SURAHS; s++) {
    const filePath = join(dataDir, `surah-${String(s).padStart(3, "0")}.json`);
    const surah = JSON.parse(readFileSync(filePath, "utf8"));
    surahs.push(surah);
  }
  return surahs;
}

test("manifest contains exactly 114 surahs with 6,236 ayahs and 82,456 words", () => {
  const manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
  assert.equal(manifest.surahs.length, EXPECTED_SURAHS);
  const totalAyahs = manifest.surahs.reduce((sum, s) => sum + s.ayahCount, 0);
  const totalWords = manifest.surahs.reduce((sum, s) => sum + s.wordCount, 0);
  assert.equal(totalAyahs, EXPECTED_AYAHS);
  assert.equal(totalWords, EXPECTED_WORDS);
});

test("all 114 surah files exist, have sequential numbers, and match ayah/word counts", () => {
  const surahs = loadAllSurahs();
  assert.equal(surahs.length, EXPECTED_SURAHS);

  let cumulativeAyahs = 0;
  let cumulativeWords = 0;

  for (let i = 0; i < surahs.length; i++) {
    const surah = surahs[i];
    const expectedSurahNumber = i + 1;
    assert.equal(surah.surahNumber, expectedSurahNumber, `Surah ${i + 1} number mismatch`);
    assert.ok(surah.name && surah.name.trim().length > 0);
    assert.ok(surah.englishName && surah.englishName.trim().length > 0);
    assert.equal(surah.ayahs.length, surah.numberOfAyahs);

    let surahWords = 0;
    for (let j = 0; j < surah.ayahs.length; j++) {
      const ayah = surah.ayahs[j];
      const expectedAyahNumber = j + 1;
      assert.equal(ayah.surahNumber, expectedSurahNumber);
      assert.equal(ayah.ayahNumber, expectedAyahNumber);
      assert.ok(ayah.text && ayah.text.trim().length > 0);
      assert.ok(ayah.wordCount > 0);
      assert.equal(ayah.words.length, ayah.wordCount);
      surahWords += ayah.wordCount;
      cumulativeAyahs++;
    }
    assert.equal(surah.totalWords, surahWords);
    cumulativeWords += surahWords;
  }

  assert.equal(cumulativeAyahs, EXPECTED_AYAHS);
  assert.equal(cumulativeWords, EXPECTED_WORDS);
});

test("canonical corpus SHA-256 hash matches the pinned constant byte-for-byte", () => {
  const surahs = loadAllSurahs();
  const actualHash = computeCorpusHash(surahs);
  assert.equal(actualHash, EXPECTED_CONTENT_HASH);
});

test("NFC/NFD normalization invariant: raw Quranic Uthmani codepoints are never normalized", () => {
  const surahs = loadAllSurahs();
  let changedUnderNfc = 0;
  let totalAyahs = 0;

  for (const surah of surahs) {
    for (const ayah of surah.ayahs) {
      totalAyahs++;
      if (ayah.text.normalize("NFC") !== ayah.text) {
        changedUnderNfc++;
      }
    }
  }

  // Over 90% of ayahs (5,771+) contain combining marks that change under NFC normalization.
  assert.ok(
    changedUnderNfc > 5000,
    `Expected over 5,000 ayahs to change under NFC, found ${changedUnderNfc}`,
  );
});

test("adversarial mutation: changing a single character or order breaks the corpus hash", () => {
  const surahs = loadAllSurahs();
  
  // Mutate first ayah
  const mutated = structuredClone(surahs);
  mutated[0].ayahs[0].text = mutated[0].ayahs[0].text + " ";
  assert.notEqual(computeCorpusHash(mutated), EXPECTED_CONTENT_HASH);

  // Swap two ayahs
  const swapped = structuredClone(surahs);
  const temp = swapped[0].ayahs[0];
  swapped[0].ayahs[0] = swapped[0].ayahs[1];
  swapped[0].ayahs[1] = temp;
  assert.notEqual(computeCorpusHash(swapped), EXPECTED_CONTENT_HASH);
});

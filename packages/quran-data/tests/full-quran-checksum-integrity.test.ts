import { describe, expect, it } from "vitest";
import { verifyCanonicalAyah, verifyCanonicalWord } from "@quran-ai/contracts";
import { buildFullQuranSurahBundle } from "../src/index";
import { getSurah, listAllSurahs } from "../src/full-quran";

// Closes the gap the production seed-full-quran-to-db.sh script had: it computed source_checksum as
// fnv1a32(rawText) — a format verifyCanonicalWord/verifyCanonicalAyah (the only functions in the
// codebase that validate these checksums) could never validate (see docs/DECISIONS.md). This proves
// buildFullQuranSurahBundle's checksums — the ones seed-full-quran-to-db.sh now actually seeds —
// validate against every real ayah/word in the full 114-surah corpus, not just the 7-ayah Fatihah
// fixture covered by quran-import.test.ts.
describe("full Quran canonical checksum integrity", () => {
  it("produces ayah and word checksums verifyCanonicalAyah/verifyCanonicalWord accept, for all 114 surahs", () => {
    const surahs = listAllSurahs();
    expect(surahs).toHaveLength(114);

    let ayahCount = 0;
    let wordCount = 0;

    for (const entry of surahs) {
      const surah = getSurah(entry.surahNumber);
      const bundle = buildFullQuranSurahBundle(surah, "tanzil", "full-quran-integrity-test-v1");

      for (const ayah of bundle.ayahs) {
        expect(verifyCanonicalAyah(ayah)).toBe(true);
        ayahCount++;
      }
      for (const word of bundle.words) {
        expect(verifyCanonicalWord(word)).toBe(true);
        wordCount++;
      }
    }

    expect(ayahCount).toBe(6236);
    expect(wordCount).toBeGreaterThan(0);
  });

  it("rejects a tampered full-Quran word checksum", () => {
    const surah = getSurah(2);
    const bundle = buildFullQuranSurahBundle(surah, "tanzil", "full-quran-integrity-test-v1");
    const tampered = { ...bundle.words[0], text: `${bundle.words[0].text}x` };

    expect(verifyCanonicalWord(tampered)).toBe(false);
  });
});

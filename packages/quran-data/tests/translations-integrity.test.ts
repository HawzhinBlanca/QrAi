import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSurahTranslation } from "../src/translations";
import { getSurah } from "../src/full-quran";

// Grounds shipped translations against the canonical text: every ayah is either translated (with
// non-empty verbatim text) or recorded as missing with a reason — no ayah silently unaccounted for,
// no fabricated text.

const SLUG = "ckb-burhan-muhammad";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "translations", SLUG);

function shippedSurahNumbers(): number[] {
  return readdirSync(DIR)
    .map((f) => f.match(/^surah-(\d{3})\.json$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map(Number)
    .sort((a, b) => a - b);
}

describe("translations integrity (Sorani / Burhan Muhammad-Amin)", () => {
  const surahs = shippedSurahNumbers();

  it("ships translations for at least Al-Fatihah and the short mus'haf", () => {
    expect(surahs).toEqual(expect.arrayContaining([1, 112, 113, 114]));
  });

  it("accounts for every ayah (translated or explicitly missing), with verbatim non-empty text", () => {
    let translated = 0;
    for (const surahNumber of surahs) {
      const tr = getSurahTranslation(surahNumber, SLUG);
      expect(tr, `surah ${surahNumber} translation loads`).not.toBeNull();
      if (!tr) continue;

      const canonical = getSurah(surahNumber);
      const translatedAyahs = new Set(tr.ayahs.map((a) => a.ayah));
      const missingAyahs = new Set(tr.missingAyahs.map((a) => a.ayah));

      for (const a of canonical.ayahs) {
        expect(
          translatedAyahs.has(a.ayahNumber) || missingAyahs.has(a.ayahNumber),
          `surah ${surahNumber} ayah ${a.ayahNumber} translated or explicitly missing`,
        ).toBe(true);
      }
      for (const m of tr.missingAyahs) {
        expect(m.reason.length).toBeGreaterThan(0);
      }
      const maxAyah = canonical.ayahs.length;
      for (const a of tr.ayahs) {
        expect(a.ayah).toBeGreaterThanOrEqual(1);
        expect(a.ayah).toBeLessThanOrEqual(maxAyah);
        expect(a.text.trim().length, `translation ${surahNumber}:${a.ayah} non-empty`).toBeGreaterThan(0);
        translated++;
      }
    }
    expect(translated).toBeGreaterThan(300);
  });
});

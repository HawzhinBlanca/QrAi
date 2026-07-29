import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getWordTimings } from "../src/word-timings";
import { getSurah } from "../src/full-quran";

// Grounds every shipped word timing against the canonical text: a timing may only reference a real
// canonical word, must be time-ordered, and every ayah without timings must carry an honest
// exclusion reason. This is what makes "matched to the canonical text" a checked fact, not a claim.

const RECITER = "alafasy";
const TIMINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "word-timings", RECITER);

function shippedSurahNumbers(): number[] {
  return readdirSync(TIMINGS_DIR)
    .map((f) => f.match(/^surah-(\d{3})\.json$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map(Number)
    .sort((a, b) => a - b);
}

describe("word-timings integrity", () => {
  const surahs = shippedSurahNumbers();

  it("ships timings for at least the pilot surahs (Al-Fatihah + the short mus'haf)", () => {
    expect(surahs).toEqual(expect.arrayContaining([1, 112, 113, 114]));
  });

  it("maps every timing to a real canonical word, time-ordered, with honest exclusions", () => {
    let checkedWords = 0;

    for (const surahNumber of surahs) {
      const timings = getWordTimings(surahNumber, RECITER);
      expect(timings, `surah ${surahNumber} timings load`).not.toBeNull();
      if (!timings) continue;

      const canonical = getSurah(surahNumber);
      const wordCountByAyah = new Map(canonical.ayahs.map((a) => [a.ayahNumber, a.words.length]));

      // Every ayah in the surah is accounted for: it has timings OR an explicit exclusion reason.
      const timedAyahs = new Set(timings.ayahs.map((a) => a.ayah));
      const excludedAyahs = new Set(timings.excludedAyahs.map((a) => a.ayah));
      for (const a of canonical.ayahs) {
        expect(
          timedAyahs.has(a.ayahNumber) || excludedAyahs.has(a.ayahNumber),
          `surah ${surahNumber} ayah ${a.ayahNumber} must be timed or explicitly excluded`,
        ).toBe(true);
      }
      for (const ex of timings.excludedAyahs) {
        expect(ex.reason.length, `exclusion of ${surahNumber}:${ex.ayah} needs a reason`).toBeGreaterThan(0);
      }

      for (const ayah of timings.ayahs) {
        expect(ayah.audioUrl.length).toBeGreaterThan(0);
        const wc = wordCountByAyah.get(ayah.ayah);
        expect(wc, `ayah ${surahNumber}:${ayah.ayah} exists in canonical`).toBeGreaterThan(0);

        // Never more timed words than canonical words (some are legitimately skipped, never invented).
        expect(ayah.words.length).toBeLessThanOrEqual(wc!);

        let prevStart = -1;
        const seenIds = new Set<string>();
        for (const w of ayah.words) {
          const m = w.wordId.match(/^(\d+):(\d+):(\d+)$/);
          expect(m, `wordId ${w.wordId} is canonical format`).not.toBeNull();
          const [, s, a, idx] = m!.map(Number) as unknown as [string, number, number, number];
          expect(s).toBe(surahNumber);
          expect(a).toBe(ayah.ayah);
          expect(idx).toBeGreaterThanOrEqual(1);
          expect(idx, `word index ${idx} within ayah ${surahNumber}:${ayah.ayah}`).toBeLessThanOrEqual(wc!);
          expect(seenIds.has(w.wordId), `duplicate wordId ${w.wordId}`).toBe(false);
          seenIds.add(w.wordId);

          expect(w.startMs).toBeGreaterThanOrEqual(0);
          expect(w.endMs, `word ${w.wordId} end after start`).toBeGreaterThan(w.startMs);
          expect(w.startMs, `word ${w.wordId} start monotonic`).toBeGreaterThanOrEqual(prevStart);
          prevStart = w.startMs;
          checkedWords++;
        }
      }
    }

    expect(checkedWords).toBeGreaterThan(500);
  });
});

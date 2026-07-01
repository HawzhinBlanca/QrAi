import type { SurahInfo } from "./api";

/**
 * Bound a practice passage to the surah's opening ayahs. Long surahs (Al-Baqara has 286
 * ayahs) must not load hundreds of reference-audio files or drive a huge alignment range;
 * the learner practices the opening passage. Chosen as 7 so the default (Al-Faatiha, 7
 * ayahs) is unchanged.
 */
export const MAX_PRACTICE_AYAHS = 7;

/** Fallback when the surah list can't be fetched — matches the API's surah-1 record. */
export const DEFAULT_SURAH: SurahInfo = {
  surahNumber: 1,
  ayahCount: 7,
  name: "Al-Faatiha",
  arabicName: "سُورَةُ ٱلْفَاتِحَةِ",
  translation: "The Opening",
  revelationType: "Meccan",
};

export interface PracticeRange {
  ayahStart: number;
  ayahEnd: number;
}

/** The bounded practice passage for a surah: ayahs 1..min(ayahCount, MAX_PRACTICE_AYAHS). */
export function practiceRange(surah: Pick<SurahInfo, "ayahCount">): PracticeRange {
  const count = Number.isFinite(surah.ayahCount) && surah.ayahCount > 0 ? surah.ayahCount : 1;
  return { ayahStart: 1, ayahEnd: Math.min(count, MAX_PRACTICE_AYAHS) };
}

/**
 * Offset into the standard 6236-ayah numbering used by the reference-audio CDN: the global
 * number of (surahNumber, localAyah) is `globalAyahOffset(list, surahNumber) + localAyah`.
 * Returns the sum of ayah counts for all surahs before `surahNumber`. Safe for surah 1 even
 * with an empty list (returns 0), which is the only reachable case before the list loads.
 */
export function globalAyahOffset(list: SurahInfo[], surahNumber: number): number {
  return list
    .filter((s) => s.surahNumber < surahNumber)
    .reduce((sum, s) => sum + (s.ayahCount || 0), 0);
}

/** SM-2 progress key so each surah/passage accumulates its own mastery. */
export function progressKey(surahNumber: number, range: PracticeRange): string {
  return `${surahNumber}:${range.ayahStart}-${range.ayahEnd}`;
}

/** Human title, e.g. "Surah Al-Faatiha". */
export function surahLabel(surah: Pick<SurahInfo, "name">): string {
  return `Surah ${surah.name}`;
}

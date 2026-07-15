// Word-level audio-segment timings for follow-along highlight (T2), consuming the data ingested
// in T1 (packages/quran-data/src/data/word-timings). Loaded lazily per surah so the initial bundle
// carries none of it. Every timing references a canonical word id (`surah:ayah:index`) that matches
// the reader's word ids exactly, so highlight is a pure id lookup — a surah with no timing data
// simply never highlights a word (graceful verse-level fallback in the reader).

import type { SurahTimings, AyahTimings, WordTiming } from "@quran-ai/quran-data";

// Vite resolves this glob at build time into one lazy chunk per surah JSON.
const timingModules = import.meta.glob<{ default: SurahTimings }>(
  "../../../../packages/quran-data/src/data/word-timings/alafasy/surah-*.json",
);

// filename -> loader, keyed by surah number.
const loaderBySurah = new Map<number, () => Promise<{ default: SurahTimings }>>();
for (const [path, loader] of Object.entries(timingModules)) {
  const m = path.match(/surah-(\d{3})\.json$/);
  if (m) loaderBySurah.set(Number(m[1]), loader);
}

const cache = new Map<number, SurahTimings | null>();

/** Load timings for a surah, or null when none were ingested for it. Cached after first load. */
export async function getSurahTimings(surahNumber: number): Promise<SurahTimings | null> {
  if (cache.has(surahNumber)) return cache.get(surahNumber) ?? null;
  const loader = loaderBySurah.get(surahNumber);
  if (!loader) {
    cache.set(surahNumber, null);
    return null;
  }
  const mod = await loader();
  cache.set(surahNumber, mod.default);
  return mod.default;
}

export function getAyahTimings(timings: SurahTimings | null, localAyahNumber: number): AyahTimings | null {
  if (!timings) return null;
  return timings.ayahs.find((a) => a.ayah === localAyahNumber) ?? null;
}

/** Absolute audio URL for a timed ayah (matched to the segments), or null. */
export function ayahAudioUrl(timings: SurahTimings | null, ayah: AyahTimings | null): string | null {
  if (!timings || !ayah) return null;
  return timings.audioBase + ayah.audioUrl;
}

/**
 * The word id to highlight at playback time `tMs` within an ayah: the last word whose segment has
 * started. Holding the highlight on the current word through the brief inter-word gaps (rather than
 * clearing to null) is what makes the follow-along read as smooth rather than flickery. Returns null
 * before the first word begins.
 */
export function recitingWordIdAt(ayah: AyahTimings | null, tMs: number): string | null {
  if (!ayah || ayah.words.length === 0) return null;
  let active: WordTiming | null = null;
  for (const w of ayah.words) {
    if (w.startMs <= tMs) active = w;
    else break; // words are start-ordered
  }
  return active?.wordId ?? null;
}

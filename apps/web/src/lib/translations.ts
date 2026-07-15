// Licensed ayah translations for the reader (T4), consuming the data ingested in T4
// (packages/quran-data/src/data/translations). Loaded lazily per surah; text is rendered VERBATIM
// (QuranEnc "no modification" term). A surah with no translation data simply shows none.

import type { SurahTranslation } from "@quran-ai/quran-data";

const SLUG = "ckb-burhan-muhammad";

const translationModules = import.meta.glob<{ default: SurahTranslation }>(
  "../../../../packages/quran-data/src/data/translations/ckb-burhan-muhammad/surah-*.json",
);

const loaderBySurah = new Map<number, () => Promise<{ default: SurahTranslation }>>();
for (const [path, loader] of Object.entries(translationModules)) {
  const m = path.match(/surah-(\d{3})\.json$/);
  if (m) loaderBySurah.set(Number(m[1]), loader);
}

const cache = new Map<number, SurahTranslation | null>();

/** Load a surah's Sorani translation, or null when none was ingested. Cached after first load. */
export async function getSurahTranslation(surahNumber: number): Promise<SurahTranslation | null> {
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

/** Map of local ayah number → verbatim translation text (missing ayahs are simply absent). */
export function translationByAyah(t: SurahTranslation | null): Map<number, string> {
  const map = new Map<number, string>();
  if (t) for (const a of t.ayahs) map.set(a.ayah, a.text);
  return map;
}

export { SLUG as TRANSLATION_SLUG };

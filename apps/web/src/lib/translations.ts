// Licensed ayah translations for the reader (T4), consuming the data ingested in T4
// (packages/quran-data/src/data/translations). Loaded lazily per surah; text is rendered VERBATIM
// (QuranEnc "no modification" term). A surah with no translation data simply shows none.

import type { SurahTranslation } from "@quran-ai/quran-data";
import { lazySurahLoader } from "./lazySurahLoader";

const SLUG = "ckb-burhan-muhammad";

/** Load a surah's Sorani translation, or null when none was ingested. Cached after first load. */
export const getSurahTranslation = lazySurahLoader<SurahTranslation>(
  import.meta.glob<{ default: SurahTranslation }>(
    "../../../../packages/quran-data/src/data/translations/ckb-burhan-muhammad/surah-*.json",
  ),
);

/** Map of local ayah number → verbatim translation text (missing ayahs are simply absent). */
export function translationByAyah(t: SurahTranslation | null): Map<number, string> {
  const map = new Map<number, string>();
  if (t) for (const a of t.ayahs) map.set(a.ayah, a.text);
  return map;
}

export { SLUG as TRANSLATION_SLUG };

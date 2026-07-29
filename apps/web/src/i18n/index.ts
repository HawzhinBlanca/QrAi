import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";

// SUPPORTED_LANGUAGE_CODES (packages/contracts) catalogs 9 languages, but
// real translated content exists ONLY for English so far — the others are placeholders. This is
// deliberate, not an oversight: shipping AI-guessed Kurdish Sorani / Arabic / Urdu / Turkish /
// Indonesian / Malay / French / German UI text for a religious-education product without
// native-speaker review would be worse than being honest that it isn't translated yet (the same
// principle already applied to tajweed content requiring scholar review, see docs/SCHOLAR_REVIEW.md
// and docs/SHIP_READINESS.md F18). Each non-English resource is an empty object so i18next's
// `fallbackLng: "en"` makes every key resolve to its real English string instead of silently
// rendering the raw key or empty text — switching languages never breaks the UI, it just doesn't
// yet show translated content for anything but English.
const EMPTY_TRANSLATION = { translation: {} } as const;

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ckb: EMPTY_TRANSLATION,
      ar: EMPTY_TRANSLATION,
      tr: EMPTY_TRANSLATION,
      ur: EMPTY_TRANSLATION,
      id: EMPTY_TRANSLATION,
      ms: EMPTY_TRANSLATION,
      fr: EMPTY_TRANSLATION,
      de: EMPTY_TRANSLATION,
    },
    lng: "ckb",
    fallbackLng: "en",
    interpolation: { escapeValue: false }, // React already escapes; double-escaping breaks Arabic/diacritics.
    react: { useSuspense: false }, // Resources are bundled synchronously — no need to suspend on load.
  });

export default i18n;

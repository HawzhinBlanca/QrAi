import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import ckb from "../locales/ckb.json";
import en from "../locales/en.json";

// SUPPORTED_LANGUAGE_CODES (packages/contracts) catalogs 9 languages. Real translated content
// exists for English, plus whatever has been REVIEWED into ckb.json — which starts empty.
//
// Nothing AI-drafted is loaded here. Drafts live in specs/kurdish-i18n/drafts/ckb.draft.json with
// status "ai-suggested" and reach this file only when a human promotes them one at a time
// (scripts/i18n-review.mjs). That is the same review gate already applied to tajweed content
// (docs/SCHOLAR_REVIEW.md), and the ~112 religious/tajweed strings are never AI-drafted at all:
// a wrong word there does not read awkwardly, it teaches a learner something false.
//
// `fallbackLng: "en"` makes every unreviewed key resolve to its real English string, so a partly
// reviewed locale is a partly Kurdish app and never a broken one. Progress: scripts/i18n-review.mjs --status
const EMPTY_TRANSLATION = { translation: {} } as const;

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ckb: { translation: ckb },
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

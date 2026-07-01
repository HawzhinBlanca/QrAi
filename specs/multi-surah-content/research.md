# Research — Multi-surah practice content (feature #4)

## Goal
Let a learner practice any of the 114 surahs, not just Al-Fatihah.

## Grounded findings (verified 2026-07-01)
- **Full Quran is already in the DB**: `canonical_surahs` = 114, `canonical_ayahs` = 6236,
  `canonical_words` = 82456. No seeding needed.
- **Backend is already generic**: `GET /v1/quran/surahs` returns all 114 with
  `{surahNumber, ayahCount, name, arabicName, translation, revelationType}`;
  `GET /v1/quran/surahs/{n}` and `/v1/quran/ayahs/{s}/{a}` are parameterized
  (`services/platform-api/src/handlers/quran.rs`). No backend change required.
- **Reference audio CDN covers all surahs**: `cdn.islamic.network/.../ar.alafasy/{globalAyah}.mp3`
  uses the standard 6236 numbering. Verified 200 for global ayahs 1, 8 (surah 2:1), 6231 (surah 114:1).
  So a surah→global-offset map (sum of preceding `ayahCount`s) drives audio.
- **The UI is the only blocker**: `apps/web/src/App.tsx` hardcodes surah 1 / ayahs 1-7 in ~8 sites
  (mount load 167, create session 251-253, resetPractice 327, alignment 341-343, tajweed 353-355,
  progress key "1:1-7" 304, audio LAST_AYAH=7 / global-ayah 520-526, LearnerHome title 788,
  practice header 929). `loadSurahVerses(n)` in `data/quran.ts` already takes a param.

## Constraints / gotchas
- `SurahInfo` TS type (`lib/api.ts`) under-declares the API response (missing arabicName/
  translation/revelationType). Extend it.
- API surah-1 name is **"Al-Faatiha"** (not the UI's old "Al-Fatihah"). Two assertions pin the old
  spelling: `App.smoke.test.tsx:127` and the layout probe `hasPractice` (`App.tsx:192`). Switch to
  API names and make those assertions spelling-agnostic / match the API.
- Long surahs (Al-Baqara = 286 ayahs) must not load 286 audio files or a huge alignment range.
  Bound the practice passage to the first `MAX_PRACTICE_AYAHS` ayahs.
- Default must stay surah 1 so the default render + hermetic tests are unchanged in behavior.

## Out of scope (MVP)
- A `practice_plans` table / plan authoring UI (deferred; progress keys by `surah:ayahStart-ayahEnd`).
- Per-word (vs per-ayah) reader granularity — unchanged from today.

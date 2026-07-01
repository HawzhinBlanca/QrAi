# Plan — Multi-surah practice content (feature #4)

## Acceptance (EARS)
- WHEN a learner opens Learner Home, THE app SHALL show a surah picker listing all 114 surahs
  (name + arabic + ayah count), defaulting to Al-Faatiha.
- WHEN a learner selects surah N and starts practice, THE app SHALL load surah N's verses, create
  the session with `surahNumber = N` and the bounded practice range, and drive alignment/tajweed/
  reference-audio/progress for surah N.
- WHEN the surah list cannot be fetched, THE app SHALL fall back to the default surah and stay usable.

## Tasks (each: edit → `bash scripts/verify.sh` green before done)
1. **`lib/surah.ts` (new, pure) + `surah.test.ts`**: `MAX_PRACTICE_AYAHS`, `DEFAULT_SURAH`,
   `practiceRange(surah)`, `globalAyahOffset(list, surahNumber)`, `progressKey(surah, range)`,
   `surahLabel(surah)`. Unit-tested (offset math, range capping, fallback).
2. **Extend `SurahInfo`** (`lib/api.ts`) with optional arabicName/translation/revelationType.
3. **`components/SurahPicker.tsx` (new)**: searchable list; calls `onSelect(surah)`; accessible.
4. **Wire `App.tsx`**: add `surahList` + `selectedSurah` state; fetch list on mount; reload verses
   when selection changes; replace the ~8 hardcoded sites with `selectedSurah` + `practiceRange` +
   `globalAyahOffset`; dynamic titles; render `SurahPicker` in LearnerHome.
4b. **Layout probe** `hasPractice` → spelling-agnostic ("Back to home").
5. **Tests**: update `App.smoke.test.tsx` (default title now "Surah Al-Faatiha"; add a picker
   assertion); keep it hermetic (fetch stubbed).
6. **Verify**: `verify.sh` VERIFY OK; live smoke-browser (mobile+desktop practice) green;
   manual preview: pick a non-Fatihah surah → practice loads it.

## Impact / risk
- Frontend-only; no backend, schema, or contract change. Default path unchanged (surah 1).
- Risk: audio global-offset off-by-one → mitigated by `surah.test.ts` (assert 2:1→8, 114:1→6231).
- Risk: breaking hermetic smoke test → mitigated by keeping default + updating pinned strings.

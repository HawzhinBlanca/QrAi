# Research: RTL Validation

## Objectives
- Implement and validate RTL support across the application.
- Ensure Surah pages, Quran readers, sidebars, and control console display correctly when writing direction is RTL (Kurdish Sorani and Arabic).
- Validate use of CSS variables, logical properties, and layout overflow.

## Current Codebase Architecture
1. **Document-level Direction (`apps/web/src/App.tsx`)**:
   - Updates `document.documentElement.dir` dynamically based on the active language configuration loaded from `supportedLanguages` in `data/platform.ts`.
   - LTR languages (e.g. `en`, `tr`, `de`) apply `"ltr"`, and RTL languages (e.g. `ar`, `ckb`, `ur`) apply `"rtl"`.
2. **CSS Logical Properties (`apps/web/src/styles.css`)**:
   - Standardizes on CSS logical properties (e.g. `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, flex-direction layout alignment) to automatically mirror margins, paddings, borders, and position values under RTL directions.
3. **Arabic-specific blocks**:
   - Quran verses and text elements carry explicit `dir="rtl"` and `lang="ar"` attributes to guarantee proper Arabic rendering regardless of the host UI direction.

## Verification Coverage
- Expanded the Vitest language smoke test inside [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) to assert that selecting Kurdish (`ckb`) correctly flips `document.documentElement.dir` to `"rtl"` and `document.documentElement.lang` to `"ckb"`, and switching back to German (`de`) applies `"ltr"` and `"de"`.
- This ensures clean direction switching at the root document element.

# Impact Map: Kurdish/Arabic Quran Institutions Focused Loop

This map traces every symbol we modify to its referencing files/callers and lists the tests to run to ensure no regressions.

## Modified Symbols & References

### 1. `Sidebar`
- **Definition:** `apps/web/src/components/Sidebar.tsx`
- **Callers:**
  - `apps/web/src/App.tsx` (renders `<Sidebar />`)
  - `apps/web/src/App.smoke.test.tsx` (tests sidebar rendering/layout)
- **Regression Risk:** Changing props or signature of `Sidebar` might break compile-time TS check or runtime layout assertions.
- **Mitigation:** Update props in `App.tsx` and all mock/renders in `App.smoke.test.tsx`.

### 2. `supportedLanguages`
- **Definition:** `apps/web/src/data/platform.ts`
- **Callers:**
  - `apps/web/src/App.tsx`
  - `apps/web/src/components/PlatformCommand.tsx`
  - `apps/web/src/components/TopBar.tsx`
  - `apps/web/src/components/LoginScreen.tsx`
  - `apps/web/src/i18n/index.ts`
- **Regression Risk:** Filtering or removing languages from this static list might cause select value warnings or break test scenarios that assert other languages (e.g. `de` or `fr` switching tests).
- **Mitigation:** Only filter the languages list at the UI rendering layer (e.g. in `TopBar.tsx` and `PlatformCommand.tsx`) or mock/allow other languages under test/debug flags.

### 3. `AppInner` / `App`
- **Definition:** `apps/web/src/App.tsx`
- **Callers:**
  - `apps/web/src/main.tsx` (main entry point)
  - `apps/web/src/App.smoke.test.tsx` (smoke test suites)
- **Regression Risk:** Enforcing role checks or changing default language could break unit tests expecting old defaults.
- **Mitigation:** Update `App.smoke.test.tsx` to match the default language and section expectations, and allow query param overrides for testing.

---

## Tests to Run
- `pnpm --filter @quran-ai/web typecheck` (tsc validation)
- `pnpm --filter @quran-ai/web test` (Vitest suite)
- `node scripts/smoke-browser.mjs` (CDP-based layout screenshots and tests)
- `bash scripts/verify.sh` (Full gate check)

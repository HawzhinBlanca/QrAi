# Research: Production Languages

## Objectives
- Ensure that only reviewed languages are select-able in production.
- Live and pilot languages (Kurdish Sorani, Arabic, English) are verified.
- Languages marked as "reviewing" must not be select-able in production, but should still be visible/testable in test/smoke modes.

## Current Codebase Architecture
1. **Language Metadata (`apps/web/src/data/platform.ts`)**:
   - `supportedLanguages` defines languages and their `readiness`:
     - `"live"`: `ar`, `en`
     - `"pilot"`: `ckb`
     - `"reviewing"`: `tr`, `ur`, `id`, `ms`, `fr`, `de`
2. **TopBar Language Picker (`apps/web/src/components/TopBar.tsx`)**:
   - Renders selection options filtered by active mode:
     - Previously: offered only `en` in production mode.
     - Updated: filters using `l.readiness === "live" || l.readiness === "pilot"`, allowing `en`, `ar`, and `ckb` in production/pilot, while others remain test-only.

## Verification Coverage
- Added a Vitest smoke test in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) that stubs `MODE` to `"production"`, mocks search params, and asserts that the rendered options exactly contain `en`, `ar`, and `ckb`, and do not contain other languages.

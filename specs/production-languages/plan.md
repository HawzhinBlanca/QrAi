# Production Languages Plan

Only allow live and pilot languages in production.

## Proposed Changes

### TopBar

#### [MODIFY] [TopBar.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/TopBar.tsx)
- Filter `offeredLanguages` in production by `readiness === "live" || readiness === "pilot"`.

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Added `only offers live and pilot languages in production mode` test case.

## Verification Plan

### Automated Tests
- Run Vitest suite:
  ```bash
  pnpm --filter @quran-ai/web test
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```

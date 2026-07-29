# Navigation Paths Plan

Verify all core navigation paths and component selections.

## Proposed Changes

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Already added test case validating Surah selection and sidebar section switches.

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

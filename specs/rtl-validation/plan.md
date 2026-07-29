# RTL Validation Plan

Verify dynamically applied HTML writing directions and RTL layout rendering.

## Proposed Changes

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Already added test assertions validating root `dir` and `lang` attribute transformations on language toggle.

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

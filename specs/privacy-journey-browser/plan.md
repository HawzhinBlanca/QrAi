# Privacy Journey In-Browser Plan

Verify the learner-facing privacy self-service journey (export, delete, confirmation state).

## Proposed Changes

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Already added a comprehensive smoke test case simulating the entire Settings privacy journey (export, confirmation state, delete execution).

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

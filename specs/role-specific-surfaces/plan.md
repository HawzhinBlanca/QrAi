# Role-Specific Surfaces Plan

Verify role-based boundary separation and client-side and server-side authorization checks.

## Proposed Changes

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Already added a test case asserting that learners cannot render the teacher queue or administrative console.

## Verification Plan

### Automated Tests
- Run Vitest suite:
  ```bash
  pnpm --filter @quran-ai/web test
  ```
- Run platform-api tests:
  ```bash
  pnpm test
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```

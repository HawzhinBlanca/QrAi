# Teacher Workflow Plan

Verify the teacher queue and review workflow.

## Proposed Changes

### Tests

#### [MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)
- Already added test case validating full teacher review queue select and submit flows.

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

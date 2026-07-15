# Learner-to-Teacher Vertical Slice Plan

Add a dedicated `smoke:e2e` script to the root `package.json` to run the fully composed browser E2E walk, validating the complete recitation, upload, alignment, and teacher-review lifecycle.

## Proposed Changes

### Configuration & Tooling

#### [MODIFY] [package.json](file:///Users/hawzhin/QrAi/package.json)
- Add `"smoke:e2e": "node scripts/smoke-e2e.mjs"` to the `"scripts"` block.

## Verification Plan

### Automated Tests
- Run the E2E script:
  ```bash
  pnpm smoke:e2e
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```

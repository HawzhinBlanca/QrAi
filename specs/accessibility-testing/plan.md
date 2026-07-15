# Accessibility Testing Plan

Verify the structural accessibility of the web interface (WCAG 2.2 AA).

## Proposed Changes
No product changes are required. The current implementation passes the axe-core rules.

## Verification Plan

### Automated Tests
- Run accessibility smoke test:
  ```bash
  pnpm smoke:a11y
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```

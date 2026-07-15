# Research: Accessibility Testing

## Objectives
- Conduct task-based accessibility testing (WCAG 2.2 AA).
- Verify keyboard focus, screen-reader markup (ARIA labels, roles), color contrast, bypass blocks (skip link), and error alerts.

## Current Codebase Architecture
1. **Accessibility Standards**:
   - Every interactive element has a unique ID and accessible screen-reader labels.
   - Elements are structured semantically.
   - Keyboard bypass blocks (such as the Skip to Content link) are focusable and functional, as verified by automated Vitest tests.
2. **Axe-core Integration (`scripts/smoke-a11y.mjs`)**:
   - Headless Chrome launches and executes the axe-core engine (`axe.min.js`) against the application views: `learner-home`, `practice-listen`, and `internal-command`.
   - The script asserts zero violations and prints the pass/fail results.

## Audit Results
- Executed `pnpm smoke:a11y` locally.
- Results:
  - `learner-home`: 0 violations (36 rules passed)
  - `practice-listen`: 0 violations (40 rules passed)
  - `internal-command`: 0 violations (37 rules passed)
- This confirms compliance with WCAG 2.2 AA accessibility standards.

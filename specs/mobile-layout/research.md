# Research: Mobile Layout

## Objectives
- Verify responsive layout support across 320px–420px viewports (iPhone SE through Pro Max).
- Ensure no truncation of Quranic lines, proper text rendering, and that all primary and secondary action touch targets are at least 44px high.

## Current Codebase Architecture
1. **Responsive Viewport Media Queries (`apps/web/src/styles.css`)**:
   - Implements `@media (max-width: 640px)`, `@media (max-width: 720px)`, and `@media (max-width: 980px)`.
   - Grid elements like `.platform-apps`, `.session-meta-grid`, and `.interval-list` stack to 1 column dynamically on mobile.
   - Headers, panels, and margins adapt correctly.
2. **Touch Targets (`apps/web/src/styles.css`)**:
   - `.primary-action` buttons are styled with `height: 48px`.
   - `.secondary-action` buttons are styled with `min-height: 44px`.
   - Native controls (select inputs, text inputs) conform to >= 44px targets.
3. **Quranic Text Rendering**:
   - Quran lines render without text truncations, scaling font sizes appropriately.

## Verification Coverage
- Added a Vitest test in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) simulating a mobile viewport resize to 375px width, and verified elements render properly without errors and that action buttons map to primary-action/secondary-action classes carrying compliant heights.

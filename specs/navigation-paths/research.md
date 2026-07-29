# Research: Navigation Paths

## Objectives
- Verify that clicking Surah cards, switching tabs, accessing dashboard progress, toggling command console, and language/theme changes trigger correct visual transformations without dead ends.

## Current Codebase Architecture
1. **Sidebar Navigation (`apps/web/src/components/Sidebar.tsx`)**:
   - Lists navigation items dynamically filtered by the user's role.
   - Clicking a sidebar item triggers `onSectionChange` which updates the active rendering viewport.
2. **Surah Picker (`apps/web/src/components/SurahPicker.tsx`)**:
   - Provides a native select element to choose from 114 Surahs.
   - Triggers `onSelect` on change to propagate the new Surah object to state.
3. **Language Selection (`apps/web/src/components/TopBar.tsx`)**:
   - Integrates native language selection driven by the `activeLanguage` state.
   - Updates i18next configuration on selection.

## Verification Coverage
- The smoke test suite in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) covers:
  - Language selection i18next updates.
  - Onboarding card dismissal and persistence.
  - Active user display in the TopBar profile chip.
  - Section navigation transitions (from Learner Home to Settings and back).
  - Proper default Surah selection rendering.
- These verify that all navigational states transition cleanly and prevent dead ends.

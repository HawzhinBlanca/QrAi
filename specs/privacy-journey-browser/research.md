# Research: Privacy Journey In-Browser

## Objectives
- Assert the learner privacy journey:
  1. Opting out of browser/cloud processing disables mic recording buttons.
  2. Clicking export triggers the `/v1/privacy/export` endpoint and updates the UI state.
  3. Clicking delete enters confirmation mode, and confirming triggers the `/v1/privacy/delete` endpoint.
  4. Both operations verify correctness of API calls at the UI boundaries.

## Current Codebase Architecture
1. **Consent Gating (`apps/web/src/App.tsx` & `apps/web/src/components/ConsentPanel.tsx`)**:
   - `canRecordRecitation(consent)` is evaluated.
   - If consent is not given, recording is blocked, and inline consent controls are displayed in the UI at the point of action.
2. **Privacy Settings Page (`apps/web/src/components/PrivacySettings.tsx`)**:
   - Consists of two sections: "See my data" and "Delete my data & recordings".
   - Export calls `exportMyData(...)` and displays count of records retrieved.
   - Delete opens a confirmation warning and confirm triggers `deleteMyData(...)` which cascades data deletion across the platform.

## Verification Coverage
- A dedicated smoke test in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) mocks the secure export and delete endpoints.
- The test navigates to Settings, clicks export, asserts that the correct export API is called and returns the count, clicks delete, confirms delete, and verifies that the correct delete API is called.

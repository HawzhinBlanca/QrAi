# Research: Teacher Workflow

## Objectives
- Verify the teacher review workflow.
- Ensure that the teacher can load the pending recitation queue, select a session, view alignments and audio options, see tajweed findings, and submit reviews (Attributable decisions).

## Current Codebase Architecture
1. **Teacher Surface (`apps/web/src/components/TeacherSurface.tsx`)**:
   - Fetches recitation sessions via `fetchRecitationSessions`.
   - Filters out non-pending sessions, showing only `teacher-review-required` sessions.
   - Fetches and displays alignments via `fetchSessionAlignments` and tajweed findings via `fetchTajweedFindings`.
   - Renders a control interface to accept, reject, or edit findings, calling `submitTeacherReview` to record a durable decision.
2. **Mocking Infrastructure**:
   - `fetchRecitationSessions`, `fetchSessionAlignments`, and `submitTeacherReview` support mock behaviors when `smoke` URL query parameter is present.
   - For complete testing of the API fetch paths, we can also intercept standard fetch calls.

## Verification Coverage
- Added a full integration smoke test case in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx):
  - Pre-seeds auth state with a teacher identity (`role: "teacher"`).
  - Stubs `window.location.search` to `smokeMode=teacher`.
  - Mocks all backend endpoints (`GET /v1/recitation-sessions`, `GET /v1/recitation-sessions/*/alignments`, `GET /v1/recitation-sessions/*/audio`, `GET /v1/tajweed-findings`, and `POST /v1/teacher-reviews`).
  - Mocks `window.Audio` and `URL` object creator to prevent JSDOM environment incompatibilities.
  - Verifies that the queue list is populated, selecting a session fetches and displays correct Arabic alignments and tajweed warnings, and accepting a finding submits to `/v1/teacher-reviews`.

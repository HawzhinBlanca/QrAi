# Plan: Kurdish/Arabic Quran Institutions Focused Loop

We will implement the prioritized feature loop focusing on a flawless learner journey, a reproducible gate check, and the teacher loop.

## Rationale
To win Kurdish/Arabic Quran institutions, we must restrict all complex internal dashboards from the learner view, ensure a clean logical RTL layout, hide untranslated dropdown choices, handle backend unreachable failures honestly, skip live tests when auth fails, and implement a direct teacher queue + review loop.

Approved-by: 

---

## Proposed Changes

### 1. Hide every non-learner surface & Restrict navigation
- **[MODIFY] [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)**
  - Pass the current user's role (`effectiveUser?.role`) to `Sidebar`.
  - Enforce that if `effectiveUser?.role === "learner"`, `activeSection` is forced to `"learner"` (or `"settings"` if active).
- **[MODIFY] [Sidebar.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/Sidebar.tsx)**
  - Accept a `userRole` string prop.
  - Filter `navItems` to display only `"learner"` and `"settings"` if `userRole === "learner"`.
- **[MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)**
  - Adjust test cases to expect only `"learner"` and `"settings"` tabs by default (since default user has `"learner"` role).

### 2. RTL Styling using CSS logical properties
- **[MODIFY] [styles.css](file:///Users/hawzhin/QrAi/apps/web/src/styles.css)**
  - Replace `right: 0; left: 0;` on the sidebar mobile query (lines 2591-2593) with `inset-inline: 0;`.

### 3. Do not offer untranslated languages
- **[MODIFY] [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)**
  - Change initial language state from `"ckb"` to `"en"`.
  - Read `lng` or `smokeMode` from URL params to allow switching for testing/smoke purposes.
  - Filter the `supportedLanguages` list in `TopBar` to only include languages that are fully translated (currently only `"en"`).
- **[MODIFY] [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx)**
  - Adjust tests asserting language selector options to use `"en"` as the default, and mock/support query param overrides for testing `ckb`/`de` fallback.

### 4. Honest "practice is temporarily unavailable" state
- **[MODIFY] [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)**
  - Catch connection errors during mounting/loading of data and set `apiError` to `t("app.errors.platformApiUnreachable")`.
  - Provide an `onRetry` recovery function that clears the error and retries the data loading.
- **[MODIFY] [LearnerHome.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/LearnerHome.tsx)**
  - If `apiError` is present and represents the connection unreachable state, render a friendly "practice is temporarily unavailable" screen with a "Retry Connection" recovery button.
- **[MODIFY] [en.json](file:///Users/hawzhin/QrAi/apps/web/src/locales/en.json)**
  - Add keys:
    - `"app.errors.practiceUnavailableTitle": "Practice is temporarily unavailable"`
    - `"app.errors.practiceUnavailableBody": "We couldn't connect to our servers to load your recitation and progress data. Please check your connection and try again."`
    - `"app.errors.retryConnection": "Retry Connection"`

### 5. Reproducible Gate: Fix Database-Auth Preflight
- **[MODIFY] [verify.sh](file:///Users/hawzhin/QrAi/scripts/verify.sh)**
  - Replace/augment `pg_isready` check with a connection and query check using `psql` (e.g. `psql "$DATABASE_URL" -c "SELECT 1"`) to guarantee authentication succeeds.

### 6. Teacher review loop
- **[NEW] [TeacherSurface.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/TeacherSurface.tsx)**
  - A dedicated view for teachers. Shows a queue of recitation sessions matching `reviewStatus === "teacher-review-required"`.
  - Selecting a session displays the recitation details, plays back the recording, and provides an approval form that sends the `teacher_review` to the backend.
- **[MODIFY] [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)**
  - Detect role `"teacher"` if `?smokeMode=teacher` is in the URL.
  - Render `<TeacherSurface />` when `activeSection === "teacher"`.
- **[MODIFY] [InternalSurface.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/InternalSurface.tsx)**
  - Prevent rendering placeholder for `"teacher"` section if a real teacher component is loaded.

---

## Verification Plan

### Automated Tests
- **RTL and Layout Integrity:** `node scripts/smoke-browser.mjs`
- **Verify gate:** `bash scripts/verify.sh`
- **E2E verification:** We will add a new test case/script `scripts/smoke-e2e.mjs` that runs the full record → analyze → review → correct flow in headless Chrome using CDP.

### EARS Acceptance Criteria
1. **WHEN** a learner accesses the app, **THE** system **SHALL** hide all non-learner surfaces from the sidebar.
2. **WHEN** a network/fetch error occurs during initial load, **THE** system **SHALL** render a "Practice is temporarily unavailable" panel with a retry recovery path.
3. **WHEN** `verify.sh` runs, **THE** script **SHALL** skip platform-api integration tests if database authentication fails.
4. **WHEN** a teacher accesses the app, **THE** system **SHALL** show the teacher review queue, play the recitation, and allow submitting corrections.
5. **WHEN** a teacher submits a correction, **THE** learner **SHALL** see it on their next recitation practice.

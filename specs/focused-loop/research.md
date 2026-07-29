# Research: Kurdish/Arabic Quran Institutions Focused Loop

We will map out the files and symbols involved in focusing the platform on a flawless Kurdish/Arabic learner journey, establishing a reproducible E2E loop, and creating the teacher review loop.

## Mapped Targets & Symbols

### 1. Hide every non-learner surface & Restrict navigation
- **File:** [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)
  - **Current Behavior:** `App` and `Sidebar` render 9 navigation tabs unconditionally. Learners can see and navigate to internal dashboards (model-ops, admin command, trust ledger, etc.).
  - **Proposed Change:**
    - Pass `effectiveUser?.role` to the `<Sidebar />` component.
    - If role is `"learner"`, enforce that `activeSection` is restricted to `"learner"` or `"settings"`.
- **File:** [Sidebar.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/Sidebar.tsx)
  - **Current Behavior:** Statically renders all 9 items in `navItems`.
  - **Proposed Change:** Accept a `role` prop and filter `navItems` to only show `"learner"` and `"settings"` for the `"learner"` role.

### 2. RTL styling using CSS logical properties
- **File:** [styles.css](file:///Users/hawzhin/QrAi/apps/web/src/styles.css)
  - **Current Behavior:** Positioning for `.sidebar` uses `left: 0; right: 0;` on mobile widths.
  - **Proposed Change:** Migrate to logical `inset-inline-start: 0; inset-inline-end: 0;` (or `inset-inline: 0;`).

### 3. Do not offer untranslated languages
- **File:** [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)
  - **Current Behavior:** Default language is `"ckb"` (Kurdish Sorani) and the language selector offers 9 languages, even though only English has a non-empty translation bundle.
  - **Proposed Change:**
    - Change default language in `useState` to `"en"`.
    - Allow query parameter `?lng=` or `?smokeMode=` to override the active language for RTL/smoke testing.
    - In `TopBar` and `PlatformCommand` language pickers, only render languages that are fully translated (currently only English `"en"`).

### 4. Honest "practice is temporarily unavailable" state
- **File:** [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)
  - **Current Behavior:** On initial data fetch failure, the app silently renders empty/zero stats. If Quran verses fail, it falls back to static Al-Fatihah but doesn't block practice.
  - **Proposed Change:**
    - Catch fetch failures during mounting and set `apiError` to `t("app.errors.platformApiUnreachable")`.
    - Provide a retry function in `App.tsx` that re-runs the initial data fetches.
- **File:** [LearnerHome.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/LearnerHome.tsx)
  - **Current Behavior:** Renders warning banner when `apiError` is present.
  - **Proposed Change:** If `apiError` indicates a backend connection issue, replace the main dashboard card and practice actions with a clean, friendly "Practice is temporarily unavailable" screen and a "Retry Connection" button.

### 5. Reproducible Gate: Fix Database-Auth Preflight
- **File:** [verify.sh](file:///Users/hawzhin/QrAi/scripts/verify.sh)
  - **Current Behavior:** Uses `pg_isready` to detect if Postgres is listening, which returns success even if authentication fails.
  - **Proposed Change:** Use `psql` to check both connectivity and authentication (e.g., `psql "$DATABASE_URL" -c "SELECT 1"`) before running live Postgres integration tests.

### 6. Teacher review loop
- **File:** [App.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.tsx)
  - **Proposed Change:** If `bypassLogin` is active and `?smokeMode=teacher` is in the URL, set user role to `"teacher"`.
  - Render a new `<TeacherSurface />` when `activeSection === "teacher"`.
- **File:** [TeacherSurface.tsx](file:///Users/hawzhin/QrAi/apps/web/src/components/TeacherSurface.tsx) [NEW]
  - **Proposed Change:**
    - Fetch recitation sessions for the tenant.
    - Render a queue of sessions with `reviewStatus === "teacher-review-required"`.
    - Selecting a session opens a details panel showing the learner's details, the Quran text/alignments, and a play button for the recorded audio (if available, otherwise fallback/local).
    - Provide a review form (decision: `accepted`/`rejected`/`edited`, notes field) which submits a review to the backend.

## Risks & Integration Points
- **Vitest & Smoke Tests:** Filtering out languages will break existing tests that switch language to `"ckb"`, `"fr"`, or `"de"`. We must update `App.smoke.test.tsx` and `smoke-browser.mjs` to work with the revised language list, or allow those languages to remain under a debug/test flag.
- **E2E verification:** We need a solid E2E browser smoke script to run the full loop.

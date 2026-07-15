# Research: Role-Specific Surfaces

## Objectives
- Assert role-specific surfaces isolation:
  1. The learner cannot view administrative consoles or teacher queues.
  2. Teachers/admins cannot view or spoof another user's recitation progress.
  3. The gateway and platform-api checks block unauthorized actions at the API boundary.

## Current Codebase Architecture
1. **Frontend Role Gating (`apps/web/src/App.tsx`)**:
   - Uses `effectiveUser?.role` redirection inside a `useEffect` hook to prevent state-based or query-parameter-based access to unauthorised views.
   - If user role is `learner`, only `learner` or `settings` sections are rendered.
   - Profile visual indicators, sidebar navigation buttons, and Command console tabs are conditionally rendered or disabled based on `effectiveUser?.role`.
2. **Backend API Boundaries (`services/platform-api/src`)**:
   - The token verification extracts the user's role (`ActorRole`) from the secure JWT token claims.
   - Elevated operations (e.g. fetching the teacher review queue, submitting reviews, viewing audit logs) require specific roles:
     - `ActorRole::require_any` / `ActorRole::require_self_or_any` are checked at the beginning of handlers.
     - Review queue listing and submissions require `ActorRole::Teacher`, `ActorRole::Admin`, or `ActorRole::Ops`.
     - Audit logs require `ActorRole::Admin` or `ActorRole::Ops`.
     - Deleting or exporting learner data requires self or Admin/Ops roles.
3. **Database RLS Policies**:
   - Isolation is enforced at the database level via Postgres RLS using the current tenant ID context.

## Verification Coverage
- Added a dedicated smoke test in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) asserting that learners are redirected back to the learner home and cannot render teacher surfaces or command consoles.
- Integration tests in [integration.rs](file:///Users/hawzhin/QrAi/services/platform-api/tests/integration.rs) assert that spoofed headers or unauthorized actions (e.g., cross-tenant or incorrect role attempts) are blocked with `403 Forbidden` / `401 Unauthorized`.

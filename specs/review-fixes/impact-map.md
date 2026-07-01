# Review Fixes Impact Map

## Frontend

- `apps/web/src/App.tsx`
  - Callers affected: initial progress/memorization load, practice session creation,
    progress save, recording start path, admin console rendering.
- `apps/web/src/lib/api.ts`
  - Callers affected: `AuthenticatedApp/startPractice`.
- `apps/web/src/data/platform.ts`
  - Callers affected: `AuthenticatedApp` progress/memorization loads,
    `PlatformCommand` console data loads.
- `apps/web/src/components/PlatformCommand.tsx`
  - Callers affected: `InternalSurface` in `App.tsx`.

## Backend/DB

- `infra/sql/0005_learner_progress.sql`
  - Adds tenant-owned table used by `handlers/progress.rs`.
- `infra/sql/0008_session_language.sql`
  - Must match `handlers/recitation.rs` insert/read surface.
- New learner-progress RLS migration
  - Must match `scripts/smoke-sql.mjs` static/live proof.
- `docker-compose.yml` and root `package.json`
  - Affect local DB bootstrap and `pnpm api:dev`.

## Tests/Verification

- `scripts/smoke-sql.mjs`
  - Static table/RLS checks and live transaction proof need learner-progress coverage.
- Existing frontend smoke tests stub `fetch`, so optional auth-token parameters should
  remain backward-compatible.


# Review Fixes Research

## Scope

Fix the issues found while reviewing changes against merge base
`3aab8e34e84d8acf32028b73cfb937d0c7e3e83c`:

- New DB migrations are not part of the Postgres bootstrap path.
- Protected web API calls still rely only on spoofable headers after the API made
  header auth opt-in.
- Learner audio can be uploaded to the ASR service even when external ASR consent
  is false.
- `learner_progress` is tenant-owned but has no RLS policy.
- `git diff --check` reports trailing blank-line errors in two vendored Python files.

## Findings

- `docker-compose.yml` mounts only `0001` through `0004`; new SQL files `0005` through
  `0008` are never applied on fresh compose databases.
- `services/platform-api/src/handlers/recitation.rs` inserts/reads
  `recitation_sessions.consent_snapshot`, but no migration currently adds that column.
- `apps/web/src/lib/api.ts` and `apps/web/src/data/platform.ts` call protected API
  endpoints using `x-tenant-id`, `x-user-id`, and `x-user-role`, while
  `services/platform-api/src/auth.rs` now rejects those headers unless
  `ALLOW_HEADER_AUTH=1`.
- `apps/web/src/App.tsx` defaults `externalAsrProcessing` to false, the consent UI
  does not toggle it, and recording still prefers `startServerAsr`.
- `scripts/smoke-sql.mjs` only checks `0001_core_schema.sql` and
  `0003_tenant_rls.sql`, so it cannot catch tenant-owned tables added in later
  migrations unless updated.


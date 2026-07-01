# RLS Bypass Guard Impact Map

## Files

- `infra/sql/0003_tenant_rls.sql`
  - Base helper definition for fresh databases.

- `infra/sql/0012_superuser_only_rls_bypass.sql`
  - Follow-up migration for existing databases.

- `scripts/smoke-sql.mjs`
  - Static assertion that the helper checks `rolsuper`.
  - Live assertion that restricted roles cannot use `app.bypass_rls` to read both tenants.

- `docker-compose.yml`
  - Fresh Postgres initialization runs the follow-up migration.

- `infra/sql/rls-app-role.sql`, `docs/TESTING.md`
  - Documentation for the production restricted role.

## Proof

- Red proof before change: non-superuser `quran_ai_rls_test` saw 2 temporary tenant rows with `app.bypass_rls=on`.
- Green proof after change: live SQL smoke keeps that role scoped to 1 tenant row.

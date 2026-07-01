# RLS Bypass Guard Plan

1. Harden the RLS helper.
   - Update the base RLS migration.
   - Add a follow-up migration for existing databases.

2. Extend live SQL smoke.
   - Keep the superuser maintenance setup path working.
   - Add a non-superuser assertion that `app.bypass_rls=on` does not expose another tenant.

3. Update docs.
   - Clarify that the restricted app role cannot use the bypass GUC.

4. Verify and commit.
   - `SQL_SMOKE_REQUIRE_LIVE=true POSTGRES_RLS_SMOKE_URL=... pnpm smoke:sql`
   - `bash scripts/verify.sh`

-- Restricted application database role for PRODUCTION.
--
-- WHY: the Postgres RLS policies (0003_tenant_rls.sql, 0009_learner_progress_rls.sql)
-- only actually isolate tenants when the connecting role is NOT a superuser and does
-- NOT have BYPASSRLS. The dev role (`hawzhin`) is a superuser and bypasses RLS, so RLS
-- is a no-op in dev — isolation there rests on the app-level `WHERE tenant_id = $1`
-- clauses plus the per-request `SET LOCAL app.tenant_id` set by `begin_tenant_tx`.
-- In production the API MUST connect as this restricted role so RLS is the enforced
-- backstop even if a query ever forgets its tenant filter.
--
-- Idempotent. Run once per environment as a superuser, then point the API's
-- DATABASE_URL at this role:
--   psql "$SUPERUSER_URL" -v app_password="$STRONG_PASSWORD" -f infra/sql/rls-app-role.sql
--   DATABASE_URL=postgresql://quran_ai_app:$STRONG_PASSWORD@host:5432/quran_ai
--
-- The API sets `app.tenant_id` per request (never `app.bypass_rls`), so this role is
-- always subject to the tenant policies.

\set ON_ERROR_STOP on

-- Create the role if it's missing (psql variables can't be interpolated inside a
-- dollar-quoted block, so the password is set by the ALTER ROLE below).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quran_ai_app') then
    create role quran_ai_app login;
  end if;
end $$;

-- Set the password (from the :app_password psql variable) and explicitly strip every
-- privilege that would let the role skip RLS.
alter role quran_ai_app login password :'app_password'
  nosuperuser nobypassrls nocreatedb nocreaterole noreplication;

grant usage on schema public to quran_ai_app;
grant usage on schema app to quran_ai_app;

-- The RLS policies call these helpers (current_setting-based); the role must execute them.
grant execute on function app.current_tenant_id() to quran_ai_app;
grant execute on function app.is_rls_bypass_enabled() to quran_ai_app;

-- CRUD on all application tables (RLS still filters rows by tenant at query time).
grant select, insert, update, delete on all tables in schema public to quran_ai_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to quran_ai_app;

-- Sanity: fail loudly if the role somehow still bypasses RLS.
do $$
declare
  is_super boolean;
  is_bypass boolean;
begin
  select rolsuper, rolbypassrls into is_super, is_bypass
  from pg_roles where rolname = 'quran_ai_app';
  if is_super or is_bypass then
    raise exception 'quran_ai_app must be nosuperuser + nobypassrls (super=%, bypass=%)',
      is_super, is_bypass;
  end if;
end $$;

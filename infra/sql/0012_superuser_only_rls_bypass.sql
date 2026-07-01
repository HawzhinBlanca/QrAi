-- 0012_superuser_only_rls_bypass.sql
-- app.bypass_rls is a maintenance escape hatch for schema/smoke setup only.
-- Custom GUCs can be set by ordinary roles, so the helper must ignore the flag
-- unless the current database role is a superuser.

create or replace function app.is_rls_bypass_enabled()
returns boolean
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.bypass_rls', true), ''), 'off') in ('on', 'true', '1')
    and exists (
      select 1
      from pg_roles
      where rolname = current_user
        and rolsuper
    )
$$;

-- Restricted application role provisioning. This file is intentionally NOT a migration:
-- credentials rotate independently from immutable schema history. The Node provisioner sets the
-- two transaction-local qrai.app_* values using protocol parameters before executing these bytes.

do $$
declare
  role_name text := current_setting('qrai.app_role');
  role_password text := current_setting('qrai.app_password');
begin
  if role_name !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'invalid application role name';
  end if;
  if length(role_password) < 16 then
    raise exception 'application role password must contain at least 16 characters';
  end if;

  if not exists (select 1 from pg_roles where rolname = role_name) then
    execute format('create role %I login', role_name);
  end if;
  execute format(
    'alter role %I login password %L nosuperuser nobypassrls nocreatedb nocreaterole noreplication',
    role_name,
    role_password
  );

  execute format('grant usage on schema public to %I', role_name);
  execute format('revoke create on schema public from %I', role_name);
  if exists (select 1 from pg_namespace where nspname = 'app') then
    execute format('grant usage on schema app to %I', role_name);
  end if;

  if to_regprocedure('app.current_tenant_id()') is not null then
    execute format('grant execute on function app.current_tenant_id() to %I', role_name);
  end if;
  if to_regprocedure('app.is_rls_bypass_enabled()') is not null then
    execute format('grant execute on function app.is_rls_bypass_enabled() to %I', role_name);
  end if;
  if to_regprocedure('app.get_pilot_session_by_hash(text)') is not null then
    execute format('grant execute on function app.get_pilot_session_by_hash(text) to %I', role_name);
  end if;
  if to_regprocedure('app.consume_pilot_invitation_by_hash(text)') is not null then
    execute format('grant execute on function app.consume_pilot_invitation_by_hash(text) to %I', role_name);
  end if;

  execute format('grant select, insert, update, delete on all tables in schema public to %I', role_name);
  execute format(
    'alter default privileges in schema public grant select, insert, update, delete on tables to %I',
    role_name
  );

  if exists (
    select 1 from pg_roles
    where rolname = role_name and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)
  ) then
    raise exception 'application role retained a privilege that can weaken tenant isolation';
  end if;
end $$;

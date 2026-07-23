-- 0021_pilot_identity.sql
-- Database schema for invited no-login pilot sessions and RLS policies.

create table pilot_invitations (
  id text primary key,
  tenant_id text not null references institutions(id),
  learner_id text not null references users(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table pilot_sessions (
  id text primary key,
  tenant_id text not null references institutions(id),
  learner_id text not null references users(id),
  token_hash text not null unique,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz
);

-- Enable RLS
alter table pilot_invitations enable row level security;
alter table pilot_invitations force row level security;

alter table pilot_sessions enable row level security;
alter table pilot_sessions force row level security;

-- RLS Policies. Must match the exact regex in smoke-sql.mjs
create policy tenant_isolation_pilot_invitations
  on pilot_invitations
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_pilot_sessions
  on pilot_sessions
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

-- SECURITY DEFINER functions for RLS-bypassed lookup by token hash (the caller has no
-- tenant context yet at auth time). `set search_path` is mandatory here: without it the
-- caller's pg_temp is searched first for relations, letting anyone with SQL access as the
-- app role shadow pilot_sessions/pilot_invitations with a forged temp table and mint
-- sessions for arbitrary tenants.
create or replace function app.get_pilot_session_by_hash(p_token_hash text)
returns table (
  id text,
  tenant_id text,
  learner_id text,
  csrf_token text,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
security definer
set search_path = public, pg_temp
language sql
as $$
  select id, tenant_id, learner_id, csrf_token, idle_expires_at, absolute_expires_at
  from pilot_sessions
  where token_hash = p_token_hash
    and revoked_at is null
    and now() < absolute_expires_at;
$$;

create or replace function app.consume_pilot_invitation_by_hash(p_token_hash text)
returns table (
  tenant_id text,
  learner_id text
)
security definer
set search_path = public, pg_temp
language plpgsql
as $$
declare
  v_tenant_id text;
  v_learner_id text;
begin
  update pilot_invitations
  set consumed_at = now()
  where token_hash = p_token_hash
    and consumed_at is null
    and expires_at > now()
  returning pilot_invitations.tenant_id, pilot_invitations.learner_id into v_tenant_id, v_learner_id;

  if v_tenant_id is not null then
    return query select v_tenant_id, v_learner_id;
  end if;
end;
$$;

-- These functions are session-minting oracles: only the app role may call them.
-- Postgres default-grants EXECUTE on new functions to PUBLIC; strip it.
revoke execute on function app.get_pilot_session_by_hash(text) from public;
revoke execute on function app.consume_pilot_invitation_by_hash(text) from public;

-- Grant to the restricted app role IF it exists. In compose initdb and CI the role is
-- created AFTER migrations (99_init_app_role.sh / rls-app-role.sql), so this guard skips
-- there and rls-app-role.sql applies the same grants; in an environment whose role was
-- provisioned earlier (production), this path applies them. Both files stay in sync.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'quran_ai_app') then
    grant execute on function app.get_pilot_session_by_hash(text) to quran_ai_app;
    grant execute on function app.consume_pilot_invitation_by_hash(text) to quran_ai_app;
  end if;
end $$;

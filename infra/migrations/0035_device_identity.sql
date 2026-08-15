-- Final-purpose native device enrollment and rotating session generations.
--
-- Raw invitation/access/refresh values never belong in Postgres. These tables contain SHA-256
-- hashes and bounded identifiers only. Tenant discovery is possible only through the three exact
-- hash lookup functions below; every later write remains inside an ordinary forced-RLS tenant
-- transaction under the restricted application role.

create table device_enrollment_invitations (
  id text primary key,
  tenant_id text not null references institutions(id),
  user_id text not null references users(id),
  created_by text not null references users(id),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now(),
  constraint device_enrollment_expiry_check check (expires_at > created_at),
  constraint device_enrollment_consumed_check check (
    consumed_at is null or consumed_at >= created_at
  )
);

create unique index device_enrollment_token_hash_unique
  on device_enrollment_invitations(token_hash);

create index device_enrollment_tenant_user_active
  on device_enrollment_invitations(tenant_id, user_id, expires_at, created_at, id)
  where consumed_at is null;

create table device_sessions (
  id text primary key,
  family_id text not null check (length(family_id) between 1 and 128),
  previous_session_id text,
  tenant_id text not null references institutions(id),
  user_id text not null references users(id),
  generation integer not null check (generation >= 0),
  previous_generation integer generated always as (
    case when generation = 0 then null else generation - 1 end
  ) stored,
  access_token_hash text not null check (access_token_hash ~ '^[0-9a-f]{64}$'),
  refresh_token_hash text not null check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('active', 'rotated', 'revoked', 'replayed')),
  access_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now(),
  constraint device_session_identity_lineage_unique unique (id, family_id, generation),
  constraint device_session_previous_generation_fk foreign key
    (previous_session_id, family_id, previous_generation)
    references device_sessions(id, family_id, generation),
  constraint device_session_lineage_shape check (
    (generation = 0 and previous_session_id is null)
    or (generation > 0 and previous_session_id is not null)
  ),
  constraint device_session_expiry_order check (
    access_expires_at > created_at
    and idle_expires_at > created_at
    and absolute_expires_at >= access_expires_at
    and absolute_expires_at >= idle_expires_at
    and last_seen_at <= idle_expires_at
  ),
  constraint device_session_state_check check (
    (
      status = 'active'
      and rotated_at is null
      and revoked_at is null
    )
    or
    (
      status = 'rotated'
      and rotated_at is not null
      and revoked_at is null
    )
    or
    (
      status = 'revoked'
      and revoked_at is not null
    )
    or
    (
      status = 'replayed'
      and rotated_at is not null
      and revoked_at is not null
    )
  )
);

create unique index device_session_access_hash_unique on device_sessions(access_token_hash);
create unique index device_session_refresh_hash_unique on device_sessions(refresh_token_hash);
create unique index device_session_family_generation_unique on device_sessions(family_id, generation);
create unique index device_session_one_active_generation
  on device_sessions(family_id) where status = 'active';
create unique index device_session_previous_unique
  on device_sessions(previous_session_id) where previous_session_id is not null;
create index device_session_tenant_user_created
  on device_sessions(tenant_id, user_id, created_at desc, id);
create index device_session_expiry
  on device_sessions(tenant_id, status, idle_expires_at, absolute_expires_at, id);

alter table device_enrollment_invitations enable row level security;
alter table device_enrollment_invitations force row level security;
alter table device_sessions enable row level security;
alter table device_sessions force row level security;

create policy tenant_isolation_device_enrollment_invitations
  on device_enrollment_invitations
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_device_sessions
  on device_sessions
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create or replace function app.consume_device_enrollment_invitation_by_hash(p_token_hash text)
returns table (invitation_id text, tenant_id text, user_id text)
security definer
set search_path = public, pg_temp
language plpgsql
as $$
declare
  v_invitation_id text;
  v_tenant_id text;
  v_user_id text;
begin
  update device_enrollment_invitations as dei
     set consumed_at = now()
   where dei.token_hash = p_token_hash
     and dei.consumed_at is null
     and dei.expires_at > now()
  returning dei.id, dei.tenant_id, dei.user_id
       into v_invitation_id, v_tenant_id, v_user_id;

  if v_invitation_id is not null then
    return query select v_invitation_id, v_tenant_id, v_user_id;
  end if;
end;
$$;

create or replace function app.get_device_session_by_access_hash(p_token_hash text)
returns table (
  session_id text,
  family_id text,
  tenant_id text,
  user_id text,
  role text,
  display_name text,
  generation integer,
  status text,
  access_expires_at timestamptz,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
security definer
set search_path = public, pg_temp
language sql
as $$
  select ds.id, ds.family_id, ds.tenant_id, ds.user_id, u.role, u.display_name,
         ds.generation, ds.status, ds.access_expires_at, ds.idle_expires_at,
         ds.absolute_expires_at
    from device_sessions as ds
    join users as u on u.id = ds.user_id and u.tenant_id = ds.tenant_id
   where ds.access_token_hash = p_token_hash;
$$;

create or replace function app.get_device_session_by_refresh_hash(p_token_hash text)
returns table (
  session_id text,
  family_id text,
  tenant_id text,
  user_id text,
  generation integer,
  status text,
  access_expires_at timestamptz,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz
)
security definer
set search_path = public, pg_temp
language plpgsql
as $$
begin
  return query
    select ds.id, ds.family_id, ds.tenant_id, ds.user_id, ds.generation, ds.status,
           ds.access_expires_at, ds.idle_expires_at, ds.absolute_expires_at,
           ds.rotated_at, ds.revoked_at
      from device_sessions as ds
     where ds.refresh_token_hash = p_token_hash
     for update of ds;
end;
$$;

revoke execute on function app.consume_device_enrollment_invitation_by_hash(text) from public;
revoke execute on function app.get_device_session_by_access_hash(text) from public;
revoke execute on function app.get_device_session_by_refresh_hash(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'quran_ai_app') then
    grant execute on function app.consume_device_enrollment_invitation_by_hash(text) to quran_ai_app;
    grant execute on function app.get_device_session_by_access_hash(text) to quran_ai_app;
    grant execute on function app.get_device_session_by_refresh_hash(text) to quran_ai_app;
  end if;
end $$;

comment on table device_enrollment_invitations is
  'Single-use native enrollment invitations; token values are stored only as SHA-256 hashes.';
comment on table device_sessions is
  'Rotating native session generations retaining hash-only replay lineage per credential family.';

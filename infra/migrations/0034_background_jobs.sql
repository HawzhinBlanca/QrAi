-- Durable tenant-scoped outbox/jobs for bounded background effects.
--
-- The table contains identifiers and bounded JSON control/result documents only. Raw audio,
-- transcripts, credentials, signing material, and dependency responses do not belong here.
-- A worker claims inside an ordinary tenant transaction; no cross-tenant SECURITY DEFINER lease or
-- BYPASSRLS role is introduced.

create table background_jobs (
  id text primary key,
  tenant_id text not null references institutions(id),
  kind text not null check (
    kind in ('session.finalize', 'session.evaluate', 'privacy.export', 'privacy.delete')
  ),
  subject_id text not null check (length(subject_id) between 1 and 256),
  actor_id text not null references users(id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (
    status in ('queued', 'running', 'retry', 'completed', 'dead')
  ),
  priority smallint not null default 0 check (priority between -100 and 100),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or length(lease_owner) between 1 and 128),
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  result jsonb,
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  dead_at timestamptz,
  constraint background_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint background_jobs_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint background_jobs_attempts_check check (
    attempt_count <= max_attempts and lease_generation = attempt_count
  ),
  constraint background_jobs_state_check check (
    (
      status = 'queued'
      and attempt_count = 0
      and lease_owner is null and lease_expires_at is null
      and result is null and last_error_code is null
      and completed_at is null and dead_at is null
    )
    or
    (
      status = 'running'
      and attempt_count > 0
      and lease_owner is not null and lease_expires_at is not null
      and result is null and last_error_code is null
      and completed_at is null and dead_at is null
    )
    or
    (
      status = 'retry'
      and attempt_count > 0 and attempt_count < max_attempts
      and lease_owner is null and lease_expires_at is null
      and result is null and last_error_code is not null
      and completed_at is null and dead_at is null
    )
    or
    (
      status = 'completed'
      and attempt_count > 0
      and lease_owner is null and lease_expires_at is null
      and result is not null and last_error_code is null
      and completed_at is not null and dead_at is null
    )
    or
    (
      status = 'dead'
      and attempt_count = max_attempts
      and lease_owner is null and lease_expires_at is null
      and result is null and last_error_code is not null
      and completed_at is null and dead_at is not null
    )
  )
);

create unique index background_jobs_tenant_kind_key_unique
  on background_jobs(tenant_id, kind, idempotency_key);

create index background_jobs_ready
  on background_jobs(tenant_id, priority desc, available_at, created_at, id)
  where status in ('queued', 'retry');

create index background_jobs_expired_lease
  on background_jobs(tenant_id, lease_expires_at, created_at, id)
  where status = 'running';

create index background_jobs_dead
  on background_jobs(tenant_id, dead_at desc, id)
  where status = 'dead';

create index background_jobs_subject
  on background_jobs(tenant_id, kind, subject_id, created_at desc);

alter table background_jobs enable row level security;
alter table background_jobs force row level security;

create policy tenant_isolation_background_jobs
  on background_jobs
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

comment on table background_jobs is
  'Tenant-scoped durable outbox/jobs; payloads and results contain control metadata, never audio.';

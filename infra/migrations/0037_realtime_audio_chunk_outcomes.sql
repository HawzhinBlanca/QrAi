-- Durable, tenant-scoped diagnostics for the gap between realtime enqueue, private object storage,
-- and the playback index. This table is not a playback authority: audio_chunks remains the only
-- index read by review routes, and stored object metadata remains the repair candidate authority.

create table realtime_audio_chunk_outcomes (
  tenant_id text not null references institutions(id),
  session_id text not null,
  chunk_id text not null,
  start_ms integer not null,
  end_ms integer not null,
  sample_rate integer not null,
  initial_outcome text not null,
  reason_code text not null,
  first_observed_at timestamptz not null default clock_timestamp(),
  repaired_at timestamptz,
  constraint realtime_audio_chunk_outcomes_pkey
    primary key (tenant_id, session_id, chunk_id),
  constraint realtime_audio_chunk_outcomes_session_fk
    foreign key (tenant_id, session_id)
    references recitation_sessions(tenant_id, id)
    on delete cascade,
  constraint realtime_audio_chunk_outcomes_span_check
    check (start_ms >= 0 and end_ms > start_ms),
  constraint realtime_audio_chunk_outcomes_sample_rate_check
    check (sample_rate in (16000, 24000, 48000)),
  constraint realtime_audio_chunk_outcomes_initial_check
    check (initial_outcome in ('accepted-lost', 'stored-unindexed')),
  constraint realtime_audio_chunk_outcomes_reason_check
    check (
      reason_code in (
        'store-failed',
        'store-aborted',
        'index-failed',
        'index-conflict',
        'reconciled-orphan'
      )
    ),
  constraint realtime_audio_chunk_outcomes_reason_matches_initial_check
    check (
      (initial_outcome = 'accepted-lost' and reason_code in ('store-failed', 'store-aborted'))
      or
      (initial_outcome = 'stored-unindexed'
        and reason_code in ('index-failed', 'index-conflict', 'reconciled-orphan'))
    )
);

create index realtime_audio_chunk_outcomes_open
  on realtime_audio_chunk_outcomes(
    tenant_id,
    initial_outcome,
    repaired_at,
    session_id,
    chunk_id
  );

alter table realtime_audio_chunk_outcomes enable row level security;
alter table realtime_audio_chunk_outcomes force row level security;

create policy tenant_isolation_realtime_audio_chunk_outcomes
  on realtime_audio_chunk_outcomes
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

comment on table realtime_audio_chunk_outcomes is
  'Diagnostic state for accepted-lost and stored-unindexed realtime chunks; never playback authority.';
comment on column realtime_audio_chunk_outcomes.repaired_at is
  'Database time when a verified stored object gained its durable audio_chunks index; nullable while degraded.';

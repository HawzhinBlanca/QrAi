-- Privacy-safe client recovery truth for one recitation capture.
--
-- The v1 audio wire has no client chunk id, so client uncertainty cannot be deduplicated against
-- server accepted-loss. These source counts stay separate. A legacy session has every field NULL
-- and is unverified; once a client supplies a report, the trigger makes that first report immutable.

alter table recitation_sessions
  add column capture_report_version smallint,
  add column capture_report_state text,
  add column capture_total_chunks integer,
  add column capture_acknowledged_chunks integer,
  add column capture_dropped_chunks integer,
  add column capture_uncertain_chunks integer,
  add column capture_stop_reason text,
  add column capture_reported_at timestamptz,
  add constraint recitation_sessions_capture_all_or_none_check
    check (
      (
        capture_report_version is null
        and capture_report_state is null
        and capture_total_chunks is null
        and capture_acknowledged_chunks is null
        and capture_dropped_chunks is null
        and capture_uncertain_chunks is null
        and capture_stop_reason is null
        and capture_reported_at is null
      )
      or
      (
        capture_report_version = 1
        and capture_report_state is not null
        and capture_total_chunks is not null
        and capture_acknowledged_chunks is not null
        and capture_dropped_chunks is not null
        and capture_uncertain_chunks is not null
        and capture_stop_reason is not null
        and capture_reported_at is not null
      )
    ),
  add constraint recitation_sessions_capture_accounting_check
    check (
      capture_total_chunks >= 0
      and capture_acknowledged_chunks >= 0
      and capture_dropped_chunks >= 0
      and capture_uncertain_chunks >= 0
      and capture_total_chunks =
        capture_acknowledged_chunks + capture_dropped_chunks + capture_uncertain_chunks
    ),
  add constraint recitation_sessions_capture_state_check
    check (capture_report_state in ('complete', 'degraded')),
  add constraint recitation_sessions_capture_reason_check
    check (
      capture_stop_reason in (
        'completed',
        'retry-exhausted',
        'buffer-overflow',
        'ack-ambiguous',
        'ack-invalid',
        'rejected-exhausted',
        'drain-timeout',
        'device-failure'
      )
    ),
  add constraint recitation_sessions_capture_complete_check
    check (
      (
        capture_report_state = 'complete'
        and capture_stop_reason = 'completed'
        and capture_dropped_chunks = 0
        and capture_uncertain_chunks = 0
      )
      or
      (
        capture_report_state = 'degraded'
        and capture_stop_reason <> 'completed'
      )
    );

create function app.reject_recitation_capture_report_rewrite()
returns trigger
language plpgsql
as $$
begin
  if old.capture_report_version is not null
     and row(
       old.capture_report_version,
       old.capture_report_state,
       old.capture_total_chunks,
       old.capture_acknowledged_chunks,
       old.capture_dropped_chunks,
       old.capture_uncertain_chunks,
       old.capture_stop_reason,
       old.capture_reported_at
     ) is distinct from row(
       new.capture_report_version,
       new.capture_report_state,
       new.capture_total_chunks,
       new.capture_acknowledged_chunks,
       new.capture_dropped_chunks,
       new.capture_uncertain_chunks,
       new.capture_stop_reason,
       new.capture_reported_at
     )
  then
    raise exception 'recitation capture recovery report is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger recitation_sessions_capture_report_immutable
before update of
  capture_report_version,
  capture_report_state,
  capture_total_chunks,
  capture_acknowledged_chunks,
  capture_dropped_chunks,
  capture_uncertain_chunks,
  capture_stop_reason,
  capture_reported_at
on recitation_sessions
for each row
execute function app.reject_recitation_capture_report_rewrite();

comment on column recitation_sessions.capture_report_state is
  'Client-declared complete/degraded capture integrity; NULL means legacy/unverified.';
comment on column recitation_sessions.capture_dropped_chunks is
  'Frames known by the client not to have been accepted; never summed with server loss.';
comment on column recitation_sessions.capture_uncertain_chunks is
  'Frames sent without a v1 acknowledgement; never replayed or summed with server loss.';
comment on column recitation_sessions.capture_reported_at is
  'Database time when the first immutable client recovery report was accepted.';

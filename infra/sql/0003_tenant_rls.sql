create schema if not exists app;

create or replace function app.current_tenant_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')
$$;

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

alter table users enable row level security;
alter table users force row level security;
alter table consent_records enable row level security;
alter table consent_records force row level security;
alter table recitation_sessions enable row level security;
alter table recitation_sessions force row level security;
alter table audio_chunks enable row level security;
alter table audio_chunks force row level security;
alter table word_alignments enable row level security;
alter table word_alignments force row level security;
alter table tajweed_findings enable row level security;
alter table tajweed_findings force row level security;
alter table teacher_reviews enable row level security;
alter table teacher_reviews force row level security;
alter table scholar_approvals enable row level security;
alter table scholar_approvals force row level security;
alter table agent_runs enable row level security;
alter table agent_runs force row level security;
alter table realtime_session_tickets enable row level security;
alter table realtime_session_tickets force row level security;
alter table alignment_runs enable row level security;
alter table alignment_runs force row level security;
alter table privacy_jobs enable row level security;
alter table privacy_jobs force row level security;
alter table audit_events enable row level security;
alter table audit_events force row level security;
alter table eval_runs enable row level security;
alter table eval_runs force row level security;

create policy tenant_isolation_users
  on users
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_consent_records
  on consent_records
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_recitation_sessions
  on recitation_sessions
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_audio_chunks
  on audio_chunks
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_word_alignments
  on word_alignments
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_tajweed_findings
  on tajweed_findings
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_teacher_reviews
  on teacher_reviews
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_scholar_approvals
  on scholar_approvals
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_agent_runs
  on agent_runs
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_realtime_session_tickets
  on realtime_session_tickets
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_alignment_runs
  on alignment_runs
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_privacy_jobs
  on privacy_jobs
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_audit_events
  on audit_events
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

create policy tenant_isolation_eval_runs
  on eval_runs
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

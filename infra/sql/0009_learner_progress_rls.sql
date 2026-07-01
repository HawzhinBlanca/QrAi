-- 0009_learner_progress_rls.sql
-- learner_progress is tenant-owned learner state, so it must be protected by the
-- same tenant isolation policy as the other tenant tables.

alter table learner_progress enable row level security;
alter table learner_progress force row level security;

drop policy if exists tenant_isolation_learner_progress on learner_progress;
create policy tenant_isolation_learner_progress
  on learner_progress
  for all
  using (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id())
  with check (app.is_rls_bypass_enabled() or tenant_id = app.current_tenant_id());

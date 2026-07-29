-- 0018_agent_run_learner_id.sql
-- Add learner_id to agent_runs table to support privacy export and deletion logic (GDPR/right-to-erasure).
alter table agent_runs add column learner_id text references users(id);

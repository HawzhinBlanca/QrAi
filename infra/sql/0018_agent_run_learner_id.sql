-- Close a right-to-erasure gap: agent_runs has no structured learner reference at all. The
-- Practice Plan Recommender agent embeds the learner's id directly in the free-text `goal`
-- column (e.g. "Recommend the next practice step for learner-1.") but that id is never
-- covered by privacy.rs's delete cascade, which only reaches learner_progress,
-- recitation_sessions, and their derived tables. A learner who requests erasure keeps their
-- id sitting in every Practice Plan Recommender run ever generated for them, indefinitely.
--
-- Nullable: not every agent run is learner-specific (e.g. the Mistake Pattern Summarizer
-- produces a cohort-level summary with no single learner to attribute it to).
alter table agent_runs add column if not exists learner_id text;

-- Supports both the privacy-delete cascade (WHERE tenant_id = $1 AND learner_id = $2) and any
-- future "list this learner's agent runs" query; partial (WHERE learner_id IS NOT NULL) since
-- most agent_runs today are cohort-level with learner_id null.
create index if not exists idx_agent_runs_learner
  on agent_runs (tenant_id, learner_id)
  where learner_id is not null;

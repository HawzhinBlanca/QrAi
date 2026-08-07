-- list_teacher_review_queue (services/platform-api/src/handlers/review.rs) runs
-- `SELECT ... FROM teacher_reviews WHERE tenant_id = $1 ORDER BY created_at DESC`, and the
-- analogous scholar-approval queue handler runs the same shape against scholar_approvals. Every
-- other frequently-queried tenant-scoped table already has a matching index
-- (idx_sessions_tenant_learner, idx_findings_tenant_review, idx_agent_runs_tenant_status, etc. in
-- 0001_core_schema.sql) — these two were missed, forcing a sequential scan on every queue load.
create index idx_teacher_reviews_tenant_created on teacher_reviews(tenant_id, created_at desc);
create index idx_scholar_approvals_tenant_created on scholar_approvals(tenant_id, created_at desc);

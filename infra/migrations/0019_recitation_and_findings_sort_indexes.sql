-- Two more query shapes confirmed by reading the actual SQL text in
-- services/platform-api/src/handlers/*.rs (following the same pattern as
-- 0016_missing_tenant_indexes.sql), neither covered by an existing index:
--
-- 1. recitation_sessions has idx_sessions_tenant_learner(tenant_id, learner_id)
--    (0001_core_schema.sql), but `list_sessions` (recitation.rs) runs
--    `WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 50` — learner_id appears in
--    neither the WHERE nor the ORDER BY of that query, so the existing index can't be used
--    to avoid a sort. This is the query behind every load of the Internal Command console's
--    session list, on what a prior migration already called out as "the busiest write table".
--
-- 2. tajweed_findings has idx_findings_tenant_review(tenant_id, review_status)
--    (0001_core_schema.sql), but `list_teacher_review_queue` (review.rs) runs
--    `WHERE tf.tenant_id = $1 ORDER BY tf.confidence DESC` (unbounded, no LIMIT) — same
--    mismatch: review_status is not part of this query's WHERE or ORDER BY.
create index idx_sessions_tenant_started on recitation_sessions(tenant_id, started_at desc);
create index idx_findings_tenant_confidence on tajweed_findings(tenant_id, confidence desc);

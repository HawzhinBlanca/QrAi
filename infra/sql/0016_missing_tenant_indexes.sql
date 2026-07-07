-- Three frequently-hit query shapes have no covering index (all confirmed by reading the actual
-- SQL text in services/platform-api/src/handlers/*.rs — not guessed):
--
-- 1. word_alignments has NO index beyond its primary key. `list_session_alignments`
--    (recitation.rs) runs `WHERE wa.session_id = $1 AND wa.tenant_id = $2` on every load of the
--    Internal Command console AND every 5 seconds via its live-refresh poll
--    (apps/web/src/components/PlatformCommand.tsx) for as long as the console stays open — a
--    sequential scan on this table on a tight poll loop. The same (tenant_id, session_id) shape
--    is also used by the teacher-review realignment cascade and the privacy export/delete paths
--    (recitation.rs, privacy.rs).
--
-- 2. audit_events has NO index beyond its primary key, despite every mutating request appending a
--    row here (making it the fastest-growing table in the schema). `list_audit_events` (audit.rs)
--    runs `WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`.
--
-- 3. agent_runs has idx_agent_runs_tenant_status(tenant_id, status) (0001_core_schema.sql), but
--    `list_agent_runs` (agent.rs) actually runs `WHERE tenant_id = $1 ORDER BY created_at DESC
--    LIMIT 50` — status appears in neither the WHERE nor the ORDER BY of that query, so the
--    existing index does not cover it. idx_agent_runs_tenant_status is left in place since other
--    call sites may still filter by status; this adds the index the list query actually needs.
create index idx_word_alignments_tenant_session on word_alignments(tenant_id, session_id);
create index idx_audit_events_tenant_created on audit_events(tenant_id, created_at desc);
create index idx_agent_runs_tenant_created on agent_runs(tenant_id, created_at desc);

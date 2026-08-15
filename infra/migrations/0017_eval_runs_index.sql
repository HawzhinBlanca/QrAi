-- get_eval_run (services/platform-api/src/handlers/eval.rs) runs
-- `WHERE model_version_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1`, loaded on
-- every Internal Command console view (Model Ops benchmark card). eval_runs had no index beyond
-- its primary key, forcing a sequential scan for a query that only ever needs its single most
-- recent matching row.
create index idx_eval_runs_tenant_model_created on eval_runs(tenant_id, model_version_id, created_at desc);

# Research: Code Audit Remediation & Ship-Ready Hardening

This research maps out the required code and configuration updates to address the findings from the end-to-end security and robustness audit.

## Mapped Findings & Targets

### C-1: Docker Compose Insecure Secrets & Weak Check Hardening
- **Target Files:**
  - [platform-api/src/main.rs](file:///Users/hawzhin/QrAi/services/platform-api/src/main.rs#L9-L30) (update `ensure_secure_config` logic)
  - [realtime-gateway/src/main.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/main.rs#L8-L22) (update `ensure_secure_config` logic)
  - [docker-compose.yml](file:///Users/hawzhin/QrAi/docker-compose.yml#L40-L41) (replace literal secrets with composition constraints)

### C-2: `eval_runs` RLS Tenant Leakage
- **Target Files:**
  - [infra/sql/0001_core_schema.sql](file:///Users/hawzhin/QrAi/infra/sql/0001_core_schema.sql#L193) (add `tenant_id text not null references institutions(id)`)
  - [infra/sql/0003_tenant_rls.sql](file:///Users/hawzhin/QrAi/infra/sql/0003_tenant_rls.sql) (enable RLS, force RLS, add `tenant_isolation_eval_runs` policy)
  - [infra/sql/0006_seed_internal.sql](file:///Users/hawzhin/QrAi/infra/sql/0006_seed_internal.sql) (update seed statement with `tenant_id` and add `eval_runs` seed)
  - [scripts/smoke-sql.mjs](file:///Users/hawzhin/QrAi/scripts/smoke-sql.mjs) (add `"eval_runs"` to `tenantTables` and add inserts/assertions)
  - [platform-api/src/handlers/eval.rs](file:///Users/hawzhin/QrAi/services/platform-api/src/handlers/eval.rs) (update `get_eval_run` to use `begin_tenant_tx`)

### H-1: `ALLOW_HEADER_AUTH` in Compose
- **Target Files:**
  - [docker-compose.yml](file:///Users/hawzhin/QrAi/docker-compose.yml#L43) (remove `ALLOW_HEADER_AUTH: "1"`)

### H-2: ML Inference Auth & CORS Hardening
- **Target Files:**
  - [ml-inference/server.mjs](file:///Users/hawzhin/QrAi/services/ml-inference/server.mjs) (add shared secret auth header check, lock down CORS origins)

### H-3: Redis KEYS Scan count
- **Target Files:**
  - [realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs#L262-L276) (replace `KEYS` with `SCAN` cursor loop)

### M-4: Stale Fallback Headers in Web API Client
- **Target Files:**
  - [apps/web/src/lib/api.ts](file:///Users/hawzhin/QrAi/apps/web/src/lib/api.ts#L9-L16) (only emit `x-*` headers when `authToken` is absent)

### L-1: Unbounded audio-storage in ML Inference
- **Target Files:**
  - [ml-inference/server.mjs](file:///Users/hawzhin/QrAi/services/ml-inference/server.mjs) (add a simple daily cron/interval cleanup or retention logic)

### L-3: Hardcoded 7 ayahs in `validateCanonicalImportBundle`
- **Target Files:**
  - [packages/quran-data/src/index.ts](file:///Users/hawzhin/QrAi/packages/quran-data/src/index.ts#L77-L107) (replace with dynamic count matching the input bundle length/seed)

### I-1: HF ASR Model force-align Crash
- **Target Files:**
  - [services/asr-inference/server.py](file:///Users/hawzhin/QrAi/services/asr-inference/server.py#L215-L280) (guard/check `model is not None` before calling `whisper.transcribe`, or use HF pipeline fallback)

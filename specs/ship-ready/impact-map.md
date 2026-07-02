# Impact Map: Remediation & Ship-Ready Hardening

Below is the symbol-level impact map of files and callers affected by the changes.

## Impacted Components

### 1. `platform-api` Config Guard
- **File:** [platform-api/src/main.rs](file:///Users/hawzhin/QrAi/services/platform-api/src/main.rs)
- **Symbol:** `ensure_secure_config`
- **Callers:** `main()` (internal entry point)
- **Test Impact:** No tests call this function directly (it panics on invalid env config, but `verify.sh` tests skip `main` execution).

### 2. `realtime-gateway` Config Guard
- **File:** [realtime-gateway/src/main.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/main.rs)
- **Symbol:** `ensure_secure_config`
- **Callers:** `main()`
- **Test Impact:** No tests call this function directly.

### 3. Database Schema & RLS
- **Files:**
  - [infra/sql/0001_core_schema.sql](file:///Users/hawzhin/QrAi/infra/sql/0001_core_schema.sql)
  - [infra/sql/0003_tenant_rls.sql](file:///Users/hawzhin/QrAi/infra/sql/0003_tenant_rls.sql)
  - [infra/sql/0006_seed_internal.sql](file:///Users/hawzhin/QrAi/infra/sql/0006_seed_internal.sql)
- **Affected Tables:** `eval_runs`
- **Test Impact:**
  - `gets_eval_run_from_postgres` in [tests/integration.rs](file:///Users/hawzhin/QrAi/services/platform-api/tests/integration.rs) will run with RLS enforced.
  - `smoke-sql.mjs` will now check RLS enforcement on the `eval_runs` table.

### 4. `platform-api` Eval Handler
- **File:** [platform-api/src/handlers/eval.rs](file:///Users/hawzhin/QrAi/services/platform-api/src/handlers/eval.rs)
- **Symbol:** `get_eval_run`
- **Callers:** platform-api router
- **Test Impact:** `gets_eval_run_from_postgres` integration test.

### 5. `realtime-gateway` Redis Session Count
- **File:** [realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- **Symbol:** `active_session_count`
- **Callers:** `metrics()`, `RealtimeGateway::metrics()`
- **Test Impact:** Gateway unit tests and metrics endpoints.

### 6. Web API Client headers
- **File:** [apps/web/src/lib/api.ts](file:///Users/hawzhin/QrAi/apps/web/src/lib/api.ts)
- **Symbol:** `actorHeaders`
- **Callers:** `createRecitationSession`, `persistSessionAlignments`
- **Test Impact:** Web application network requests.

### 7. `quran-data` Import Bundle Validation
- **File:** [packages/quran-data/src/index.ts](file:///Users/hawzhin/QrAi/packages/quran-data/src/index.ts)
- **Symbol:** `validateCanonicalImportBundle`
- **Callers:** Bundle validation tests
- **Test Impact:** `pnpm test` in `quran-data` package.

### 8. Python ASR Inference
- **File:** [services/asr-inference/server.py](file:///Users/hawzhin/QrAi/services/asr-inference/server.py)
- **Symbol:** `force_align`
- **Callers:** `/v1/force-align` route
- **Test Impact:** ASR server-specific test scripts.

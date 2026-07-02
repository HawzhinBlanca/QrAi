# Plan: Remediation & Ship-Ready Hardening

We will address the findings identified in the audit report systematically.

## Proposed Changes

### 1. Docker Compose & Secret Security (C-1, H-1)
- Update `ensure_secure_config` in `services/platform-api/src/main.rs` and `services/realtime-gateway/src/main.rs` to validate that `JWT_SECRET` and `REALTIME_GATEWAY_TICKET_SECRET` are not the compose placeholder (`"production-secret-change-me"`), and are at least 32 characters long.
- Modify `docker-compose.yml` to remove the default values for `JWT_SECRET` and `REALTIME_GATEWAY_TICKET_SECRET` and require they be set on the host using the `${VAR:?error}` syntax. Remove `ALLOW_HEADER_AUTH: "1"`.

### 2. Tenant Isolation & Database Security (C-2)
- Add `tenant_id` to `eval_runs` in `infra/sql/0001_core_schema.sql` and apply RLS/force RLS and policy `tenant_isolation_eval_runs` in `infra/sql/0003_tenant_rls.sql`.
- Update `infra/sql/0006_seed_internal.sql` to include `tenant_id` for seeded `eval_runs` records.
- Update `scripts/smoke-sql.mjs` to add `"eval_runs"` to `tenantTables` and seed `eval_runs` records in the RLS test run.
- Update `platform-api/src/handlers/eval.rs` to use `begin_tenant_tx` for fetching eval runs.

### 3. Service Security (H-2)
- Update `ml-inference/server.mjs` to verify incoming requests. We will introduce a simple API key check (`x-ml-api-key`) for service-to-service calls (like from `realtime-gateway` or `platform-api`) and for browser-side requests (using the same API key, passed via the environment variable `VITE_ML_API_KEY`).
- We will set `VITE_ML_API_KEY` to `smoke-ml-api-key` in `docker-compose.yml` and `apps/web/vite-env.d.ts` as needed.
- Wait, to verify service-to-service calls cleanly without breaking existing setup:
  - If `ML_API_KEY` env var is set, the ML service will require `x-ml-api-key` header to match it.
  - In `realtime-gateway`, we will read `ML_API_KEY` from env (default to `"smoke-ml-api-key"` if empty) and pass it as `x-ml-api-key` header.
  - In `apps/web`, we will pass `VITE_ML_API_KEY` (defaults to `"smoke-ml-api-key"`) as `x-ml-api-key` header.

### 4. Redis Keys Scan Optimization (H-3)
- Rewrite `active_session_count` in `services/realtime-gateway/src/lib.rs` using a `SCAN` loop instead of `KEYS`.

### 5. Web Client Fallback Headers (M-4)
- Update `apps/web/src/lib/api.ts`'s `actorHeaders` helper to omit `x-tenant-id`, `x-user-id`, and `x-user-role` headers if the `authToken` parameter is provided.

### 6. Unbounded Audio Storage Cleanup (L-1)
- In `ml-inference/server.mjs`, run a periodic cleanup task (every 1 hour) that scans `audio-storage` and deletes files older than 24 hours (unless they are marked for teacher-review).

### 7. Hardcoded Ayah Count Validation (L-3)
- In `packages/quran-data/src/index.ts`, replace the hardcoded `7` ayahs check in `validateCanonicalImportBundle` with a dynamic check based on the length of the seeded ayahs array.

### 8. Python ASR Whisper Force-Align Crash (I-1)
- In `services/asr-inference/server.py`, guard `whisper.transcribe` with a check that `model` is not `None`. If it is `None` (using HF pipeline), throw an error or use the HF pipeline to do alignment. Since HF model doesn't support force-align via whisper.transcribe directly, return a clear error or fallback gracefully.

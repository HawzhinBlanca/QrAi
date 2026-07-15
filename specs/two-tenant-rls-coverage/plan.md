# Adversarial Two-Tenant RLS Coverage Plan

Create a dedicated adversarial test suite to verify that Tenant B cannot access, modify, enumerate, export, or delete Tenant A data at either the SQL database layer or the HTTP API layer.

## User Review Required

> [!IMPORTANT]
> The integration tests will run against the staging database using the restricted role `quran_ai_app`, proving that RLS is fully active and prevents tenant cross-talk.

## Proposed Changes

### Platform API Integration Tests

#### [MODIFY] [integration.rs](file:///Users/hawzhin/QrAi/services/platform-api/tests/integration.rs)
- Add a new block of tests under the module/comment `// --- Adversarial Cross-Tenant RLS & Security Tests ---`:
  1. `adversarial_sql_isolation_prevents_cross_tenant_access`: Connects as `quran_ai_app` restricted role, sets transaction tenant to Tenant B, and attempts to select or insert into `users` or `recitation_sessions` under Tenant A's tenant ID, verifying that RLS blocks it.
  2. `adversarial_api_isolation_prevents_cross_tenant_read`: Sends GET requests for recitation sessions, progress, and audit logs using Tenant B header credentials but referencing Tenant A IDs/data, verifying they return 404 (Not Found) or 403 (Forbidden).
  3. `adversarial_api_isolation_prevents_cross_tenant_write`: Sends POST/PUT requests using Tenant B headers to insert data (e.g. recitation sessions, reviews, progress) targeting Tenant A IDs, verifying they are blocked or correctly scoped to Tenant B.
  4. `adversarial_api_isolation_prevents_cross_tenant_delete`: Sends privacy delete jobs from Tenant B targeting Tenant A learner IDs, verifying that Tenant B cannot export or delete Tenant A's records or audio chunks.

## Verification Plan

### Automated Tests
- Run the new integration tests:
  ```bash
  source scripts/stack.env && cargo test --test integration adversarial_
  ```
- Run the entire verification gate:
  ```bash
  bash scripts/verify.sh
  ```

# Research: Adversarial Two-Tenant RLS Coverage

## Objectives
- Map out the system boundary for row-level security (RLS) and multi-tenancy.
- Ensure Tenant A cannot enumerate, read, modify, export, review, or delete Tenant B data.
- Enumerate all tables with RLS and identify where RLS or tenant isolation could potentially be bypassed or breached.
- Implement an automated negative/adversarial two-tenant integration test suite that proves these boundaries hold.

## Relevant Code & Architecture
1. **Database Schema & RLS Policies**:
   - `infra/sql/0003_tenant_rls.sql` enables RLS and configures policies on:
     - `users`
     - `consent_records`
     - `recitation_sessions`
     - `audio_chunks`
     - `word_alignments`
     - `tajweed_findings`
     - `teacher_reviews`
     - `scholar_approvals`
     - `agent_runs`
     - `realtime_session_tickets`
     - `alignment_runs`
     - `privacy_jobs`
     - `audit_events`
     - `eval_runs`
   - `infra/sql/0009_learner_progress_rls.sql` enables RLS on:
     - `learner_progress`
   - Global tables:
     - `institutions`, `canonical_ayahs`, `canonical_words`, `model_versions` are global.
2. **Restricted DB Role**:
   - `infra/sql/rls-app-role.sql` configures the restricted `quran_ai_app` login role without superuser or bypassrls privileges.
3. **Transaction Tenant Context**:
   - `begin_tenant_tx` in `services/platform-api/src/lib.rs` initializes transactions and executes `SET LOCAL app.tenant_id = <tenant_id>`.
4. **Endpoint Authentication**:
   - `actor_from_headers` in `services/platform-api/src/auth.rs` extracts user identity, tenant, and role.
5. **Privacy Operations**:
   - `erase_ml_audio` in `services/platform-api/src/handlers/privacy.rs` calls the ML service to delete audio blobs located under the tenant-scoped object path (`tenantId/learnerId/chunkId.bin`).

## Adversarial Attacks to Validate
We will create integration tests that act as a hostile tenant (Tenant B) attempting to access/manipulate Tenant A's data:
1. **Direct DB Reads/Writes (Adversarial SQL)**:
   - Run SQL queries under the restricted role `quran_ai_app` with `app.tenant_id = 'tenant-b'` and attempt to query/insert/update/delete rows belonging to `tenant-a`.
2. **API Endpoint Enumeration/Reading (Adversarial API Reads)**:
   - Call GET endpoints (e.g., `/v1/learner/progress`, `/v1/recitation-sessions`, `/v1/audit-events`, `/v1/teacher/review-queue`, `/v1/tajweed-findings`, `/v1/agent-runs`) with Tenant B credentials/headers while targeting Tenant A IDs or resources.
3. **API Endpoint Mutation (Adversarial API Writes)**:
   - Call POST/PUT/DELETE endpoints (e.g., `/v1/recitation-sessions`, `/v1/teacher/reviews`, `/v1/agent-runs`, `/v1/privacy/jobs`) attempting to insert or modify records belonging to Tenant A or under Tenant A's scope.
4. **Durable Audio blob isolation (Adversarial Storage/Privacy)**:
   - Invoke privacy exports or deletions from Tenant B targeting Tenant A's learner IDs, verifying that Tenant B cannot access or erase Tenant A's files.

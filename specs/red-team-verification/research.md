# Research: Red Team Verification

## Objectives
- Run penetration testing checks.
- Verify dynamic audit log events and access control enforcement on all API routes.

## Current Codebase Architecture
1. **Adversarial / Penetration Testing Suite (`tests/integration.rs`)**:
   - `adversarial_sql_isolation_prevents_cross_tenant_access`: Verifies RLS blocks cross-tenant reads at the database level.
   - `adversarial_api_isolation_prevents_cross_tenant_read`: Verifies that attempts to fetch recitation sessions belonging to another tenant fail.
   - `adversarial_api_isolation_prevents_cross_tenant_write`: Verifies that attempts to create/update records in another tenant's workspace fail.
   - `adversarial_api_isolation_prevents_cross_tenant_delete`: Verifies that cross-tenant deletion attempts are rejected.
2. **Audit Logging Integration**:
   - Every mutation, registration, session creation, teacher review, and deletion writes to `audit_events` (dynamic tracking).
   - `list_audit_events_returns_real_rows_not_a_fallback_empty_list` integration test asserts that the platform reads back active audit records from the database instead of using mocked fallbacks.

## Compliance Summary
- Automated penetration and security isolation tests are active.
- Access controls and audit logging are fully verified.

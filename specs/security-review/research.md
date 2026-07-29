# Research: Independent Security Review

## Objectives
- Conduct a security review covering threat modeling, vulnerability analysis, and penetration testing logs.
- Address the key areas specified:
  - **Authentication**: JWT token validation, registration privilege isolation, password strength, timing attack resistance (bcrypt dummy hash).
  - **RLS (Row Level Security)**: Database-level tenant isolation, `quran_ai_app` restricted role, adversarial test cases.
  - **CORS & CSWSH**: Origin validation on HTTP API and WebSocket upgrades.
  - **SQL Injection**: Audit parameterized query usage across all database query sites.
  - **Path Traversal**: Validate input sanitization on file paths and storage directories.

## Vulnerability Map & Mitigations
1. **Privilege Escalation during Registration**:
   - Threat: Anyone can register an admin/ops user.
   - Mitigation: Self-service registration is strictly learner-only. Elevated roles require an active admin session to register.
2. **Timing Attacks on Login**:
   - Threat: Attacker enumerates user accounts by measuring bcrypt verification time.
   - Mitigation: Platform-api uses a dummy timing decoy hash (`DUMMY_PASSWORD_HASH`) for non-existent users so that the execution time is uniform.
3. **Cross-Tenant Tenant Hopping**:
   - Threat: Tenant B accesses Tenant A's private recitations or progress.
   - Mitigation: Database-level RLS policies enforced on all tenant-owned tables via the restricted `quran_ai_app` role.
4. **WebSocket Cross-Site WebSocket Hijacking (CSWSH)**:
   - Threat: A malicious website establishes a WebSocket connection to the gateway using the user's browser credentials.
   - Mitigation: The gateway validates the `Origin` header against `CORS_ALLOWED_ORIGINS` and rejects missing or mismatched origins.
5. **Path Traversal in Audio Chunk Uploads**:
   - Threat: Attacker writes files outside the storage sandbox.
   - Mitigation: All file-path segments (`tenantId`, `learnerId`, `chunkId`) are sanitized by `safeStorageSegment`, rejecting hyphens, slashes, null bytes, and traversal patterns.

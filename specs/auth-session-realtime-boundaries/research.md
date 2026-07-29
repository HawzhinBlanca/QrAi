# Research: Auth, Session, and Realtime Boundaries

## Objectives
- Map and validate security boundaries for authentication (JWT, registration), session validation, CORS, and Realtime Gateway tickets.
- Verify rejections fail closed for:
  - Expired tokens/tickets.
  - Replayed tickets.
  - Forged tokens/tickets/signatures.
  - Cross-tenant requests.
  - Cross-role requests.
  - Malformed tokens/requests.
  - Origin-violating (CORS / CSWSH) requests.

## Existing Coverage & Implementation
1. **Realtime Gateway Ticket Validation**:
   - Signature checks, session mismatch, expiration, malformed, and tampered tickets are tested in `validates_signed_realtime_tickets`.
   - Cross-tenant ticket rejections are tested in `check_ticket_rejects_cross_tenant_ticket`.
   - Single-use (replay) ticket rejections are tested in `check_ticket_rejects_a_replayed_ticket` (using memory and Redis).
2. **Realtime Gateway Origin Validation (CSWSH)**:
   - WebSocket upgrades require Origin validation matching `CORS_ALLOWED_ORIGINS`. Tested in `test_audio_ws_origin_validation`.
3. **Platform API Auth Validation**:
   - JWT validation, expiration, and key mismatch are tested in `a_bearer_token_signed_with_a_different_secret_is_rejected` and `issue_token_sets_an_expiry_in_the_future_matching_the_configured_ttl`.
   - Role boundaries (cross-role) are validated by endpoints (e.g. `list_active_learners_is_distinct_and_staff_only` and `request_teacher_review_flips_own_draft_session_and_is_owner_gated`).
   - Cross-tenant boundaries are validated by RLS policies and new adversarial tests.

## Identified Gaps
- There is no automated test validating CORS / Origin boundaries at the Platform API HTTP layer (to verify that a non-allowed origin request is rejected by the tower CORS middleware when `CORS_ALLOWED_ORIGINS` is set).
- We should consolidate these negative cases into a documented verification matrix and add a test for Platform API CORS boundaries.

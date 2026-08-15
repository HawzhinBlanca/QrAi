# W2.16 specification — controlled device enrollment

**Status:** approved by the repository owner on 2026-08-07 · **Umbrella criterion:** BE-2

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| IDN-1 | WHEN an enabled device enrollment receives one valid unconsumed invitation, THE server SHALL atomically consume it and issue one expiring session whose tenant, user, and role come only from stored rows. | `tests/e2e/device-enrollment.test.mjs` exchange/server-authority cases |
| IDN-2 | IF an invitation is unknown, forged, expired, consumed, or concurrently reused, THEN THE server SHALL return the same generic 401 and SHALL NOT create another active session. | `tests/e2e/device-enrollment.test.mjs` invalid/reuse/concurrency cases |
| IDN-3 | WHEN an active refresh credential is presented, THE server SHALL atomically rotate both credentials into one next generation and retain the family relationship needed for replay detection. | `tests/e2e/device-enrollment.test.mjs` rotation/concurrency cases |
| IDN-4 | IF any rotated refresh credential is replayed, THEN THE server SHALL commit whole-family revocation before returning generic 401, and every access/refresh generation in that family SHALL subsequently fail. | `tests/e2e/device-enrollment.test.mjs` replay-family cases |
| IDN-5 | WHEN a protected request uses a device access credential, THE server SHALL accept only the active unexpired generation and SHALL derive its current role from the same-tenant `users` row. | `tests/e2e/device-enrollment.test.mjs`, `tests/node-api/authz.test.mjs` |
| IDN-6 | WHEN the current device session is deleted, THE server SHALL revoke its whole family; IF the credential is already expired or revoked, THEN no protected action SHALL be authorized. | `tests/e2e/device-enrollment.test.mjs` logout/expiry cases |
| IDN-7 | WHEN device identity rows/functions are installed or queried, THE system SHALL enforce forced tenant RLS, restricted execution grants, pinned definer search paths, and no privileged runtime role. | `tests/migrations/device-identity-migration.test.mjs`, `tests/migrations/restricted-role.test.mjs` |
| IDN-8 | WHEN credentials are stored, audited, logged, returned as errors, exported, or deleted, THE system SHALL persist hashes only, reveal raw values only at issuance, redact them from logs/errors, and delete tenant/user credential rows before user erasure. | `tests/e2e/device-enrollment.test.mjs`, `tests/node-api/no-secret-logging.test.mjs`, privacy parity/E2E |
| IDN-9 | WHEN an operator provisions a device invitation or a missing user, THE command SHALL validate an existing in-tenant admin, SHALL permit creation only as learner/teacher/scholar, and SHALL record the admin actor without accepting a session role. | `tests/e2e/device-enrollment.test.mjs` provisioning cases |
| IDN-10 | WHILE the owner has not declared production activation, THE executable routes SHALL remain disabled by default, Web login SHALL remain off, and password/pilot compatibility surfaces SHALL remain unchanged. | `tests/node-api/boot-guard.test.mjs`, `tests/contract/retired-routes.test.mjs`, existing pilot/auth parity |

No criterion changes canonical Quran bytes, learner-facing feedback authority, pilot-cookie behavior,
the transitional JWT format, or Flutter authentication state in this backend slice.

# W2.16 research — controlled device enrollment

**Status:** complete · **Date:** 2026-08-07 · **Criterion:** BE-2

## Grounded current state

- Serena is unavailable; the main agent and one read-only research subtask mapped exact symbols, callers,
  migrations, and tests with `rg` plus source inspection. No runtime code changed.
- ADR-0038/0050 accept one-time invitation exchange, server-derived tenant/role, hash-only access
  and refresh material, rotation/revocation/expiry, provisioned staff, and no Redis/NATS. Login and
  login UI remain off until a separate production declaration.
- Node has two identity forms only: admin/ops-issued HS256 JWTs and browser-only pilot cookies from
  `pilot.mjs::{mintInvitation,bootstrap,logout}`.
- `resolveActor` verifies Bearer before cookie before optional development headers. Bearer claims
  currently carry tenant/role, while pilot identity is discovered through locked-down
  `app.get_pilot_session_by_hash` and rolled inside `withTenant`.
- Migration 0021 owns browser/learner-specific pilot tables, forced RLS, security definers, PUBLIC
  revocation, and restricted grants; it stays unchanged for Rust/Web compatibility.
- Flutter secure storage rejects release-embedded dev tokens but holds one bearer only; enrollment,
  refresh, logout/401, and auth-state rebuild belong to later W4.10.
- Transitional Web/Expo still call password login/register; W2.16 must not delete those routes or
  re-enable the default Web login gate.
- No admin-provisioned staff command exists. `users.role` is constrained and tenant-RLS protected;
  current staff rows are seed/registration artifacts, not a final provisioning mechanism.
- The manifest ends at 0034. Additive 0035 needs forced RLS, hardened definers/restricted grants,
  schema convergence, SQL-smoke inventory, and privacy deletion coverage.

## Selected design constraints

- Add final-purpose `device_enrollment_invitations` and versioned `device_sessions`; do not overload
  transitional pilot tables. Each session row is one generation, retaining replay relationships.
- Use 256-bit opaque, domain-prefixed access/refresh/invitation values and persist SHA-256 hashes only.
  Generic 401 makes invalid states indistinguishable; credentials never enter logs/audits/errors/CLI args.
- Exchange atomically consumes one invitation and creates generation zero. Tenant, user, and role
  come only from the stored invitation/user row. Refresh locks a generation, rotates both tokens,
  and retains the prior row; replay revokes the whole family before returning 401.
- Access lookup is a narrow security-definer oracle followed by tenant-scoped expiry, active-generation,
  role, and idle-roll checks. Role comes from `users`, never the credential or request.
- Logout revokes the whole family and is authenticated by the current access token. Access tokens
  are short-lived; refresh/family have bounded idle and absolute lifetimes. Durations are server
  constants, not caller-selected.
- Provide one restricted-DB operator command that validates an in-tenant admin, optionally creates
  a learner/teacher/scholar user, writes an audit plus invitation, and prints the raw invitation
  once. It never provisions admin/ops or accepts a caller-selected session role.
- No new runtime dependency, password/KDF, broker, public user-creation route, bearer JWT change,
  Flutter UI, DPoP/App-Attest claim, or removal occurs in W2.16.

## Current standards and proof obligations

- RFC 9700 requires sender constraint or refresh rotation with replay detection; the generation chain
  uses rotation: <https://www.rfc-editor.org/info/rfc9700/>. DPoP remains later native-key work:
  <https://www.rfc-editor.org/info/rfc9449/>.
- NIST SP 800-63B-4 recognizes proof-of-possession/device-bound session credentials and requires
  session secrets erased on logout/expiry: <https://pages.nist.gov/800-63-4/sp800-63b.html>.
  OWASP MASVS keeps secure storage/auth as explicit mobile controls: <https://mas.owasp.org/MASVS/>.
- Proof must cover one-time exchange, expiry, forged token, server-derived role/tenant, concurrent
  refresh, replay-family revocation, access expiry, explicit logout, cross-tenant RLS, hash-only
  storage, log/response redaction, admin-only provisioning, route/OpenAPI registry, and exact gate
  invocation. The accepted criterion test is `tests/e2e/device-enrollment.test.mjs`.

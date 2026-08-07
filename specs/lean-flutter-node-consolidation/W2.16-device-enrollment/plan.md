# W2.16 plan — controlled device enrollment

**Status:** APPROVED
**Approved-by:** repository owner — explicit “approved” continuation on 2026-08-07
**Criteria:** BE-2 / IDN-1–IDN-10

## Approach

1. **Prove additive identity state red first.** Add live migration tests for final-purpose
   `device_enrollment_invitations` and generation-based `device_sessions`: forced RLS, hash/expiry
   constraints, one-active-generation uniqueness, family lineage, replay state, hardened
   tenant-discovery functions, and restricted grants. Then add checksum-locked migration 0035 and
   update manifest, schema-convergence, role, smoke, and privacy inventories.
2. **Add one opaque credential boundary.** Create `server/src/identity/device-sessions.mjs` for
   256-bit domain-prefixed token generation/hashing, invitation exchange, access resolution,
   refresh rotation/replay-family revocation, expiry, and logout. Keep access at 15 minutes, idle
   family life at 7 days, absolute family life at 30 days; all are server constants.
3. **Preserve the existing auth order.** In `resolveActor`, recognize only the reserved
   `qrai_at_v1.` Bearer prefix as a device credential and resolve it through Postgres; every other
   Bearer continues through the exact HS256 compatibility verifier. Pilot cookie and explicitly
   enabled development-header paths remain unchanged. The role is joined from `users` per request.
4. **Expose only the three approved operations.** Implement exchange, refresh, and current-session
   DELETE handlers plus strict OpenAPI schemas and registry entries. Exchange accepts only
   `invitationToken`; refresh only `refreshToken`; neither accepts tenant/user/role. A strict
   `DEVICE_IDENTITY_ENABLED` gate defaults off and tests opt in, preserving owner-gated login-off.
5. **Make refresh replay durable.** Lock the matching generation inside the same
   `withDiscoveredTenant` transaction. Successful refresh rotates the old row and inserts one next
   generation. First replay commits family revocation/audit and returns an outcome; the handler
   throws generic 401 only after commit, so error handling cannot roll back the security decision.
6. **Add one audited provisioning command, not another API.** The same server package command
   validates an existing in-tenant admin, invites an existing user of any stored role, or creates
   only learner/teacher/scholar when missing. It generates the raw invitation internally, prints it
   once, stores only its hash, and never accepts secrets in command arguments.
7. **Close privacy and observability boundaries.** Device identity rows are inventoried/exported
   without hashes, removed before user deletion, and excluded from raw logs/audit metadata. Add
   fixed-outcome security metrics only if an existing bounded metric surface can carry them without
   identity labels; otherwise do not invent a credential telemetry subsystem in this slice.
8. **Verify each task before advancing.** Write the failing test first, implement the smallest
   change, run the focused proof, then the exact live-Postgres `bash scripts/verify.sh`. Record local
   evidence per task; keep W2.16 open until required remote CI is green.

## Exact implementation surface

- Schema/provisioning: new `infra/migrations/0035_device_identity.sql`, manifest, app-role grants,
  SQL smoke, migration/restricted-role/schema-equivalence tests.
- Runtime: new `server/src/identity/device-sessions.mjs` and
  `server/src/routes/device-identity.mjs`; update `authz.mjs`, route registry, app/main config,
  privacy erasure/inventory, server lint, and new `server/scripts/provision-device-enrollment.mjs`.
- Contract/proof: OpenAPI schemas/paths, route-manifest statuses, contract registry/coverage tests,
  E2E enrollment proof, authz/DB-architecture/no-secret-log/boot tests, exact verify invocation.
- Living docs/evidence: decisions implementation note, architecture, testing, data inventory,
  staging runbook, threat model, umbrella impact map, and W2.16 evidence.

## Risks, non-goals, and rollback

- Highest risks are refresh races that revoke without committing, role trust from a token/body,
  a security-definer callable by PUBLIC, cross-tenant discovery, raw credential logging, and an
  owner gate that silently defaults on. Each has a named automated refusal case.
- No password/KDF, OAuth server, Redis/NATS, DPoP/App Attest claim, Flutter controller/UI, Web/Expo
  removal, pilot-table mutation, JWT retirement, or admin/ops bootstrap mechanism is added.
- Migration 0035 is additive. With the owner gate off, rollback serves unchanged JWT/pilot flows;
  credential rows remain inert and recoverable. No destructive down migration or automatic token
  replay is allowed.

## Implementation ledger

- [x] T1 — migration 0035, forced RLS/functions/grants, convergence and smoke proof. Local
  live-Postgres canonical gate: `VERIFY OK` on 2026-08-07; required remote CI remains pending and
  the W2.16 umbrella therefore remains open.
- [x] T2 — opaque device-session domain boundary and `resolveActor` integration. Local
  live-Postgres canonical gate: `VERIFY OK` on 2026-08-07; required remote CI remains pending and
  the W2.16 umbrella therefore remains open.
- [x] T3 — three owner-gated routes, strict contracts/registry, full enrollment/replay E2E. Local
  live-Postgres canonical gate: `VERIFY OK` on 2026-08-07; required remote CI remains pending and
  the W2.16 umbrella therefore remains open.
- [x] T4 — audited admin provisioning command plus privacy and secret-redaction closure. Local
  live-Postgres canonical gate: `VERIFY OK` on 2026-08-07; required remote CI remains pending and
  the W2.16 umbrella therefore remains open.
- [x] T5 — living docs, evidence, Compose activation wiring, and complete local canonical gate.
  Local live-Postgres canonical gate: `VERIFY OK` on 2026-08-07. Required remote CI remains pending,
  so W2.16 stays unchecked in the global consolidation ledger.

Approval recorded above before implementation code or tests are written.

# W2.11 plan — restricted database and tenant transaction boundary

## Approved scope

This is implementation slice W2.11 under the owner-approved W0-W7 consolidation plan. It changes
only Node database boot and transaction discipline; it does not change schemas, canonical Quran
data, authentication state, route contracts, or traffic ownership.

## Acceptance criteria

- WHEN a Node process with local database routes connects as `SUPERUSER`, THE system SHALL refuse
  readiness/listen before serving traffic.
- WHEN it connects as a role with `BYPASSRLS`, THE system SHALL refuse readiness/listen before
  serving traffic.
- WHEN it connects as the provisioned restricted application role, THE system SHALL pass the boot
  assertion.
- WHEN tenant identity must be discovered inside a transaction, THE database boundary SHALL set a
  validated transaction-local tenant context and the shared statement timeout before tenant-owned
  work runs.
- WHEN a runtime module imports `pg`/`postgres`, accesses the raw SQL pool, or manually sets the
  tenant GUC outside the audited boundaries, THE static architecture gate SHALL fail.
- WHEN a tenant callback or database statement fails, THE pool SHALL expose no tenant context to a
  later borrower.

## Tasks

1. Extend `createDb` with one role-capability assertion and one `withDiscoveredTenant` transaction
   path sharing the existing tenant-context setup.
2. Wire the role assertion into Fastify `onReady` and bounded pool shutdown into `onClose`; preserve
   the established explicit development relaxation in `main.mjs`.
3. Replace pilot bootstrap's manual transaction/GUC sequence with `withDiscoveredTenant`.
4. Add live restricted/superuser/BYPASSRLS boot proofs, extend the tenant lifecycle proof, and add a
   hermetic database-architecture test.
5. Put both tests in the canonical gate exactly once, update living architecture/testing/decision
   docs, run focused proofs, then run `bash scripts/verify.sh` with the live restricted stack.

## Test mapping

| Criterion | Automated proof |
|---|---|
| privileged role refusal and restricted success | `tests/node-api/db-role-guard.test.mjs` |
| discovered-tenant context, timeout, and cleanup | `tests/node-api/db-tenant.test.mjs` |
| driver ownership, raw SQL allowlist, no route-owned GUC | `tests/node-api/db-architecture.test.mjs` |
| complete direct and compatibility behavior | canonical direct and through-Node parity suites |

No W2.11 ledger checkbox is eligible until canonical verification and required remote CI are green.

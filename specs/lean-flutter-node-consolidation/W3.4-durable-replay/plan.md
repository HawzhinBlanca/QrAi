# W3.4 plan — durable Postgres realtime replay authority

**Status:** APPROVED — implementation proceeds one task at a time<br>
**Approved-by:** Repository owner — explicit “approved” on 2026-08-08<br>
**Criteria:** RRP-1…RRP-6; parent RT-1

## Decision

Add one `realtime_ticket_replay_claims` table and one `server/src/realtime/replay.mjs` module. The
only credential-derived stored value is lowercase SHA-256 of the signed nonce. The row is scoped by
tenant and session, uses `numeric(20,0)` for the full unsigned-64 expiry domain, and references the
tenant/session pair with `ON DELETE CASCADE`. The existing issuance table, Rust gateway, Redis
oracle, ticket wire, clients, and traffic topology stay unchanged.

After W3.3 validates Origin/ticket/tenant/session/retention/expiry/rate, admission awaits one
restricted-role `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` transaction. A returned row is
fresh; no row is the generic 401 replay/invalid class; any database exception or timeout is a
bodyless 503. There is no in-memory fallback. Database time independently rejects expired inserts,
so cleanup plus a lagging Node clock cannot reopen a replay window.

## Test-first implementation sequence

1. Add red migration proof for exact 0036 shape/checksum, composite session ownership, forced RLS,
   hash/range constraints, unique claims, tenant isolation, cascade erasure, and bounded cleanup
   index. Update hard-coded migration counts/last-migration assertions only after the red proof.
2. Add red replay proof with a claims-only fake boundary, two independent restricted pools/apps
   racing the same ticket, process restart, same nonce in another signed session, wrong scope,
   DB-expired claim, hash-only storage, context redaction, bounded locked/error 503, cleanup, fixed
   metrics, and exact no-upgrade responses.
3. Add checksum-locked migration 0036. Create a redundant composite unique key on
   `recitation_sessions(tenant_id,id)` solely for the tenant-matching FK, then create
   `realtime_ticket_replay_claims(tenant_id,session_id,nonce_hash,expires_at_unix_seconds,claimed_at)`
   with composite primary key, forced RLS/policy, cascade FK, u64/hash checks, and expiry index.
4. Implement `replay.mjs` without a dependency: strict claims validation, UTF-8 SHA-256 without
   normalization, ordinary `db.withTenant`, atomic insert from the visible matching learner session,
   DB-clock expiry refusal, and bounded ordered `FOR UPDATE SKIP LOCKED` cleanup. Its lifecycle owns
   one unref'd fixed interval, waits for in-flight cleanup on stop, and reports only fixed counters.
5. Make `createRealtimeAdmission().admit` async and require an injected replay claim. Record
   `accepted` only after a fresh durable claim; add fixed `replay_rejected` and
   `replay_unavailable` outcomes; remove nonce from the socket context. Update every direct caller
   and W3.2/W3.3 fake without weakening Origin/ticket/rate assertions.
6. Compose the real authority from the existing restricted DB in `realtime/main.mjs`, start cleanup
   only when Fastify becomes ready, stop/wait before `db.end`, and keep start-process construction
   non-overridable. No Compose service/env/port/route/dependency changes are required.
7. Run the isolated measured profile after 32 warm-up claims: 512 unique claims, concurrency 32,
   zero wrong outcomes, p95 `<100 ms`, throughput `>=100 claims/s`. These thresholds are twice the
   current 50/s canary burst and reserve most of the 1,000 ms HTTP p95 budget for other work. A pass
   selects Postgres for Node; it does not authorize Rust/Redis removal or traffic movement.
8. Update migration/schema/RLS/smoke/core-table inventories, ADR/living docs, exact-one verification,
   and W3.4 evidence. Run focused tests, `git diff --check`, then `bash scripts/verify.sh` with live
   restricted Postgres. Push only a clean branch, require exact-SHA CI, then update the W3.4 ledger.

## Exact implementation surface

- New runtime/schema: `server/src/realtime/replay.mjs`;
  `infra/migrations/0036_realtime_ticket_replay.sql` and manifest entry.
- Existing runtime: `server/src/realtime/{admission,main}.mjs`; no ticket/route/audio module changes.
- New proof: `tests/migrations/realtime-replay-migration.test.mjs` and
  `tests/realtime/replay-protection.test.mjs`.
- Regression proof: `tests/realtime/{ticket-boundary,process-lifecycle}.test.mjs`;
  `tests/migrations/{migration-runner,schema-equivalence,device-identity-migration}.test.mjs`;
  `tests/contract/{verify-invocations,realtime-decisions}.test.mjs`.
- Inventory/gates: `infra/migrations/manifest.json`, `packages/contracts/src/index.ts`,
  `packages/contracts/tests/platform-contracts.test.ts`, `scripts/smoke-sql.mjs`, and
  `scripts/verify.sh`. `scripts/smoke-all.mjs` remains unchanged because its session truncation is
  already `CASCADE`; the W3.4 migration test must prove that cleanup path.
- Decisions/living docs: `docs/{DECISIONS,TESTING,STAGING_RUNBOOK,DATA_INVENTORY}.md`,
  `docs/architecture/10-10-platform.md`, `README.md`, `monitoring/README.md`, parent impact map, and
  final evidence. No dependency manifest, lockfile, Compose, Flutter/Web, or Rust source edit.

## Risks and rollback

- A uniqueness key that omits session scope falsely rejects a separately signed session; the
  explicit same-nonce/different-session case prevents this. A key that includes unstable fields can
  accept the same ticket twice; the exact composite primary key prevents that mutation.
- RLS plus a mismatched FK can create a cross-tenant integrity oracle. The insert selects only a
  visible session matching tenant, session, and learner; the FK itself uses the same tenant/session
  pair. Restricted two-tenant proof pins both properties.
- Cleanup can reopen replay if it trusts the application clock or deletes live rows. DB-time insert
  refusal plus boundary rows around expiry pin safety; cleanup failure retains rows and is safe.
- Performance proof can be dishonest if it measures a mock, admin role, warm cache only, or runs
  amid the giant parallel suite. The dedicated canonical invocation uses the restricted role,
  production module, declared warm-up, isolated concurrency, and measured end-to-end claim time.
- Rollback returns Node to W3.3 while leaving additive, inert replay rows/table. Rust traffic and
  ticket issuance continue unchanged. A later forward migration may remove the table only after
  Node traffic retirement; W3.4 itself performs no destructive rollback.

## Verification boundary

Focused tests are development feedback. Completion requires live-Postgres canonical verification,
clean dependency/licence/secret gates, a clean synchronized branch, all required exact-SHA remote CI,
and the ledger command. Until those are all green, W3.4 remains unchecked and uncommitted as done.

**APPROVAL RECORDED:** The repository owner approved this exact schema, threshold, surface, and
sequence on 2026-08-08. Implementation remains bound to the test-first and proof gates above.

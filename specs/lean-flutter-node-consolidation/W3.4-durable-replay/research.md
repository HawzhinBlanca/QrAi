# W3.4 research — durable cross-instance realtime replay

**Status:** complete · **Date:** 2026-08-08 · **Criterion:** RT-1

## Grounded current state

- Serena is unavailable in this session; the main agent and one read-only research subagent mapped
  symbols/callers with `rg` and exact source inspection. No runtime code changed during research.
- Node W3.3 validates Origin, HMAC, session, tenant, retention, expiry, lifetime, and rate, then
  upgrades. `createRealtimeAdmission().admit` is synchronous, increments `accepted` before any
  durable check, and returns frozen claims without the raw ticket. Node has no replay authority.
- Rust `check_ticket` uses a raw-ticket in-memory map plus optional Redis `SET NX EX` keyed by the
  ticket hash. Compose configures neither Redis nor fail-closed mode, so deployed Rust defaults to
  process-local replay only. Rust remains the traffic target/oracle; W3.4 must not remove it.
- Both ticket issuers persist a hash of the full token in forced-RLS `realtime_session_tickets`, but
  replay never reads it. Overloading that issuance/audit/privacy table would mix authorities and
  complicate rollback; W3.4 should add a claims-only replay record instead.
- The migration boundary ends at 0035/34 manifest entries. A new tenant table requires additive
  0036, manifest checksum, forced RLS, restricted-role proof, schema convergence, inventory/smoke
  updates, and exact-one canonical verification.
- `createDb.withTenant` is the sole safe Node transaction owner. The realtime process already owns
  the restricted pool and statement/connect timeouts; a security-definer or privileged replay path
  is unnecessary and would contradict the tenant boundary.

## Selected design constraints

- Persist only SHA-256 of the signed nonce as credential-derived data, with tenant/session scope,
  unsigned-64 expiry as `numeric(20,0)`, and claim time. Never accept, return, store, or log the raw
  ticket or nonce at the replay store boundary.
- Use an atomic unique `(tenant_id, session_id, nonce_hash)` insert with `ON CONFLICT DO NOTHING`.
  PostgreSQL documents that each proposed row either inserts or takes the conflict action; a
  successful `RETURNING` row is the single winner across processes.
- Bind claims to an existing tenant/session/learner under ordinary forced RLS. Add a tenant/session
  foreign key with delete cascade so both existing privacy implementations erase replay state by
  deleting the session, without new Rust/Node privacy branches.
- Compare expiry with database time during claim. This prevents a lagging application clock from
  reinserting a marker already expired by database cleanup. Invalid/missing/expired/conflicting
  claims are one generic 401; any database error/timeout is a bodyless 503 and never upgrades.
- Delete expired markers in bounded ordered batches using `FOR UPDATE SKIP LOCKED`; PostgreSQL
  explicitly permits this for queue-like multi-consumer work and documents batched CTE deletion.
  Cleanup failure retains markers (safe) and cannot turn an unavailable claim into fail-open.
- Resolve metrics honestly: durable fresh increments `accepted`; conflicts and unavailable storage
  get separate fixed outcomes. Pre-replay ticket validity must not be reported as accepted.
- Benchmark the exact restricted-role claim path after warm-up with 512 unique claims at concurrency
  32. Approval freezes a pass bar of zero incorrect outcomes, p95 under 100 ms, and at least 100
  claims/s (twice the existing 50/s burst target). This is a Postgres go/no-go measurement, not a
  claim that Postgres is faster than Redis; Rust Redis remains until later canary/retirement gates.

## Callers, collateral, and boundary

- Runtime callers: `realtime/main.mjs` and `admission.mjs`; direct consumers are W3.3 ticket tests,
  W3.2 lifecycle tests/fake DBs, Compose's internal Node shadow, and future W3.5 socket handling.
- Schema consumers: manifest/runner/equivalence/restricted-role tests, SQL smoke, `CORE_TABLES`,
  cleanup harnesses, data inventory, restore/release migrations, and the app-role table grant.
- Proof must include two independent apps/pools racing one ticket, restart persistence, same nonce
  in another signed session, hash-only storage, expiry cleanup, tenant isolation, locked/outage
  bounded 503, and the measured load profile.
- Non-goals: no frame/payload/session queue, ack/sequence, audio/storage/indexing, client change,
  public route, traffic switch, Redis service/dependency, Rust gateway rewrite, or Quran/AI output.
- Primary sources: PostgreSQL 18 [INSERT/ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html), [row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), and [SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html).

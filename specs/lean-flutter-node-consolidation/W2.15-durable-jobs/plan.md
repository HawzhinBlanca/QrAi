# W2.15 plan — durable Postgres jobs and outbox effects

**Status:** COMPLETE; local and exact-candidate remote proof are green<br>
**Approved-by:** repository owner — explicit “approved” continuation on 2026-08-07<br>
**Criteria:** BE-4, BE-6

## Approach

1. **Prove the queue schema red first.** Add live tests for one additive `background_jobs` table,
   forced tenant RLS, state constraints, deterministic ready/dead indexes, idempotency uniqueness,
   concurrent `FOR UPDATE SKIP LOCKED` claims, lease expiry, and fencing. Then add checksum-locked
   migration 0034 and update migration/RLS/restricted-role/schema/smoke inventories.
2. **Add one package-owned job boundary.** Create `server/src/jobs/store.mjs` for validated
   enqueue/read/claim/retry/complete/summary operations through `createDb` transaction wrappers, and
   `server/src/jobs/runtime.mjs` for bounded execution, polling, fixed error classification,
   backoff, dead-letter transition, result bounds, fencing, metrics, and drain. Add no dependency.
3. **Make existing workflow functions reusable, not duplicated.** In their current owners, split
   finalization, session Tajweed evaluation, and privacy export/delete into prepare (read/external
   I/O) plus commit (domain effect) functions. HTTP handlers authorize/enqueue and synchronously
   execute or await the durable job so existing 200 response bodies remain unchanged. Job effect
   commit and `completed` status share one tenant transaction.
4. **Close the irreversible privacy window.** Insert the outbox intent and audit before object
   deletion. Keep existence-check ordering and tenant hiding. On crash, the worker repeats the
   idempotent object delete and commits the existing privacy manifest/cascade once. Payloads hold
   only server-derived identifiers and bounded manifests—never bytes, transcripts, or credentials.
5. **Add one worker entrypoint from the same package.** `server/src/worker.mjs` uses the restricted
   role, discovers tenant ids without a tenant-owned scan, claims fairly per tenant, executes the
   same runtime, exposes private process health/readiness/job metrics, and drains on SIGTERM. Extend
   the existing image with a Compose worker command; do not create another service tree/package.
6. **Preserve authority boundaries.** Runtime `session.evaluate` means the existing session Tajweed
   prediction/persistence path. Offline candidate/model evaluation stays offline and signed; no job
   payload can create `eval_runs`, sign evidence, or assert release eligibility.
7. **Verify each implementation task before advancing.** Run the named focused test first, then the
   exact canonical gate with live Postgres. Update architecture, decisions, testing, operations,
   inventory/threat documentation and evidence. Keep W2.15 unchecked until required remote CI.

## Exact implementation surface

- New: `infra/migrations/0034_background_jobs.sql`, manifest entry;
  `server/src/jobs/{store,runtime}.mjs`; `server/src/worker.mjs`.
- Refactor without wire change: `server/src/routes/{session-writes,ml-proxy,privacy}.mjs`;
  `server/src/{app,main}.mjs`; `server/src/lib/{db,metrics,shutdown}.mjs` only where required.
- Runtime/build: `server/{package.json,Dockerfile}`, `docker-compose.yml`, `scripts/verify.sh`.
- Proof/inventory: new job/migration/E2E/security/worker tests; migration, RLS, smoke, contract and
  invocation guards identified in `impact-map.md`.
- Living docs: `docs/{DECISIONS,TESTING,DATA_INVENTORY,STAGING_RUNBOOK}.md`,
  `docs/architecture/10-10-platform.md`, and the umbrella impact map/evidence.

## Non-goals and rollback

- No broker, Redis, NATS, cron framework, queue ORM, public job endpoint, asynchronous client wire
  migration, raw audio in Postgres, online model-evaluation writer, or standalone agents rewrite.
- Migration 0034 is additive. Old Rust remains readable because no existing column changes. Traffic
  rollback may return to Rust while queued Node jobs remain paused/recoverable; no destructive drop
  or automatic replay under a privileged role is allowed.
- “Exactly once” is never claimed for remote inference or object delivery. It is proven only for
  fenced, idempotent observable effects committed with job completion.

## Implementation ledger

- [x] T1 — additive job/outbox schema, forced RLS, indexes, concurrency proof, smoke inventory.
  Locally verified with live PostgreSQL and the canonical gate on 2026-08-07; aggregate exact-SHA
  remote proof is recorded under T5.
- [x] T2 — tenant-scoped enqueue/claim/fence/retry/complete store and bounded runtime.
  Locally verified with live PostgreSQL and the canonical gate on 2026-08-07; aggregate exact-SHA
  remote proof is recorded under T5.
- [x] T3 — durable finalization, session-evaluation, and privacy workflows with unchanged wire bodies.
  Locally verified with live PostgreSQL and the canonical gate on 2026-08-07; aggregate exact-SHA
  remote proof is recorded under T5.
- [x] T4 — same-package worker process, private health/metrics, strict config, graceful drain.
  Locally verified with live PostgreSQL and the canonical gate on 2026-08-07; aggregate exact-SHA
  remote proof is recorded under T5.
- [x] T5 — living docs, operational recovery proof, complete canonical gate, required remote CI.
  Immutable admin/ops dead-letter replay, hostile job-boundary proof, six living-document updates,
  the live-Postgres canonical gate, and all four required exact-SHA remote checks are green. The
  evidence preserves the separate, unclaimed deployment/staging recovery obligation.

# W2.15 research — durable Postgres jobs and outbox effects

**Status:** complete · **Date:** 2026-08-07 · **Criteria:** BE-4, BE-6

## Grounded current state

- Serena is unavailable; the main agent and a read-only research subagent mapped symbols/callers with
  `rg` and exact file inspection. No W2.15 runtime code was changed.
- There is no job engine: no runnable table, lease, fencing generation, retry schedule, dead state,
  worker entrypoint, or worker service. `privacy_jobs` is a completed-result ledger, not a queue.
- `finalizeSession` calls transcript/alignment then `persistAlignmentsInTransaction`; a crash loses
  intent, while a retry can replace evidence/detach reviews. Flutter calls it before Tajweed analysis.
- `ml-proxy.mjs::proxyMl` synchronously runs `tajweed-findings:predict` and
  `persistTajweedFindings`; this runtime session evaluation is W2.15's evaluation candidate.
- `privacy.mjs::createPrivacyJob` authorizes/checks existence, lists or deletes audio, then inserts
  the completed manifest and cascade in a later transaction. A crash after audio deletion leaves no
  durable intent/result. Storage deletion itself is retry-safe after W2.14.
- Offline model evaluation stays in `services/asr-inference/evaluate_candidate.py` and the signed
  verifier; W2.15 must not invent a write route or grant release-signing authority.
- `createDb::{withTenant,forDeadline}` is the only runtime transaction owner. Forced RLS covers
  every tenant domain table; the runtime role has no `BYPASSRLS`. A worker therefore must claim per
  tenant, not scan a tenant-owned queue with a privileged role.
- The migration manifest ends at 0033. New tenant-owned schema requires an additive checksum-locked
  migration, forced RLS policy, restricted-role grant proof, schema equivalence, and smoke updates.

## Selected design constraints

- One `background_jobs` table is both outbox and queue; no Redis/NATS, queue dependency, second
  backend package, or raw audio/transcript/secret in payload/result/error.
- Kinds are `session.finalize`, `session.evaluate`, `privacy.export`, and `privacy.delete`. “Retry”
  is lifecycle policy, not a separately enqueued effect. Offline candidate evaluation remains an
  external evidence workflow until its own approved producer contract exists.
- Enqueue and its audit intent commit together under `withTenant`; a unique server-derived
  idempotency key returns the existing job for the same immutable input snapshot.
- Claims use deterministic ordering plus `FOR UPDATE SKIP LOCKED`, bounded batches, lease expiry,
  worker id, and an incrementing fencing generation. PostgreSQL 18 explicitly documents
  `SKIP LOCKED` as appropriate for multiple consumers of queue-like tables.
- Worker tenant discovery may read global `institutions`, then every claim/effect remains in a
  tenant transaction. This avoids a superuser/security-definer cross-tenant lease oracle.
- Execution is at-least-once. Exactly-once applies only to observable database effects: verify the
  fence, apply the domain write, and mark complete atomically; remote deletion stays idempotent.
- The API may claim/execute its just-enqueued job to preserve current synchronous 200 bodies. A
  separate worker uses the same domain executor to recover crashes/retries; no HTTP handler calls.
- A failed attempt records a fixed code, schedules capped backoff, and becomes `dead` at its ceiling;
  the worker exposes state/outcome metrics without changing the Rust-compatible API metrics.
- Durable polling is authoritative. PostgreSQL documents a LISTEN startup race; notifications are
  optional wake hints, never the crash-safe source of truth.

## Direct callers and proof obligations

- Runtime: `routes/{session-writes,ml-proxy,privacy}.mjs`, `app.mjs`, `main.mjs`, new job/domain
  modules and worker entrypoint; `lib/{db,deadline,shutdown}.mjs`; Docker/Compose/package scripts.
- Clients/contracts: synchronous response shapes remain unchanged for Flutter/Web and Rust parity;
  no public job-status route is added in this task.
- Proof: live migration/RLS; concurrent claim/dedup; expiry recovery/fencing; retry/backoff/dead;
  finalize/evaluate/privacy exact database effects; delete crash; cancellation; drain/metrics.
- Risks: lease shorter than dependency deadline, stale payload authority, privacy identifiers in
  errors/logs, rerun after committed effect, tenant starvation, hot polling, and tests that prove
  status once but not the effect count. Primary source: PostgreSQL 18 locking, LISTEN/NOTIFY, and RLS
  documentation at <https://www.postgresql.org/docs/current/>.

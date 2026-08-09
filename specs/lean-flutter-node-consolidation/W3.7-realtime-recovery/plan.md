# W3.7 plan — realtime recovery and honest fallback

**Status:** APPROVED — implementation proceeds one criterion slice at a time
**Approved-by:** Repository owner — explicit “approved” on 2026-08-09
**Criteria:** RRF-1…RRF-7; parent RT-3

## Decision

Keep the v1 raw-binary/seven-field-ack wire byte-identical. It lacks a client idempotency key, so
the approved policy permits safe reconnect only when no sent frame is ambiguous. It uses one
in-flight frame, retains captured PCM FIFO under both a 125-item and 2 MiB ceiling, re-tickets every
attempt, and resets equal-jitter retry state only after an accepted acknowledgement. Ambiguity,
overflow, invalid acknowledgement, exhausted retry, or device failure stops capture and finalizes;
it never silently drops or replays uncertain audio.

Add one additive migration to store a closed, privacy-safe recovery summary on
`recitation_sessions`: version/state, captured/acknowledged/dropped/uncertain counts, fixed stop
reason, and reported time. Reports are optional during the migration window, authenticated before
exact-key validation, accepted only from the owning learner, immutably recorded in the authorization
transaction before job enqueue, and part of the finalization job input hash. Existing staff
finalization remains available only through the legacy empty body.
Exact retry is idempotent; conflicting retry is refused, so degradation cannot be laundered back to
complete. The response adds `recordingStatus` and source-separated counts while keeping `finalized`
as alignment-work compatibility truth. An absent legacy report is `unverified`, never `complete`.
Client uncertainty and server accepted-loss have no shared v1 id, so they are never summed or
presented as deduplicated total loss.

Create a dependency-injected Node reference recovery client under the test harness, backed by a
language-neutral policy fixture. It is executable contract evidence for Node chaos and later Dart
conformance, not a second production client. Rewrite the existing chaos script to call the same
proof boundary or retire its duplicated false-positive logic. W4.11 ports the frozen behavior into
Flutter after W3.8 decides exact PCM framing/rate. React remains untouched.

## Test-first implementation sequence

1. Add red fixture/decision tests for exact retry constants, equal-jitter vectors, dual buffer
   ceilings, one-frame window, fresh-ticket-per-attempt, healthy-reset semantics, stale callbacks,
   and terminal ambiguity. Add red exact-one verify assertions.
2. Add red migration/live-finalization cases for exact recovery-report columns/checksum,
   constraints, RLS, hostile extra/identity/audio fields, safe bounds, monotonic retry, job payload
   idempotency, exact accounting, and complete/incomplete/unverified response semantics.
3. Add the additive migration and mechanical manifest/count/schema/inventory/smoke collateral.
   Add strict request parsing before job enqueue; authorize, lock, and record the first report in one
   tenant transaction, then bind the stored fields into the job snapshot. The worker reads that
   durable state instead of trusting a job-payload copy. Preserve legacy request compatibility as
   `unverified` and keep existing authorization/inference/review gates unchanged.
4. Implement the reference recovery state machine only after its pure red cases exist. It owns one
   connect generation, ticket/handshake attempt, retry timer, one in-flight frame, dual-bounded FIFO,
   exact counters, and idempotent terminal cleanup/finalization. Raw bytes and credentials never
   enter logs, reports, exceptions, metrics, snapshots, or job documents.
5. Add live Node chaos: API-issued fresh tickets, durable replay, successful no-ambiguity reconnect,
   forced ambiguous disconnect, retry refusal/exhaustion, byte/count overflow, and finalization
   readback. Add a simulated ten-minute stream with bounded resident buffer and exact accounting;
   do not use wall-clock sleep as correctness evidence.
6. Replace or route `scripts/chaos-realtime-reconnect.mjs` through the proven policy so it requires
   acknowledged-or-explicitly-lost equality and cannot pass from `send()` counts. Keep it a manual
   candidate tool unless its environment is hermetic inside canonical verification.
7. Update OpenAPI, ADR-0051/0052 implementation note, architecture, testing, staging, monitoring,
   data inventory, parent plan/impact map, and W3.7 evidence. Record explicitly that Flutter and
   public traffic remain blocked on W3.8/W3.9/W4.11.
8. Before every slice fetch origin and compare reserved paths with parallel work. After each slice
   run focused tests and `bash scripts/verify.sh`. Only after live proof, clean synchronized branch,
   non-force push, exact-final-SHA required CI, evidence, and the guarded ledger command may W3.7 be
   checked complete.

## Exact implementation surface

- New contract/proof/schema: `packages/contracts/fixtures/realtime/recovery-policy.json`,
  `infra/migrations/0038_realtime_recovery_report.sql`,
  `tests/migrations/realtime-recovery-migration.test.mjs`, and
  `tests/e2e/realtime-recovery.test.mjs` plus a test-local helper if needed.
- Finalization domain: `server/src/routes/session-writes.mjs`, `packages/contracts/openapi.yaml`,
  and finalization parity/job regression tests. `server/src/jobs/workflows.mjs` remains unchanged
  unless a red crash/retry test proves stored session state is insufficient.
- Migration/inventory collateral: `infra/migrations/manifest.json`, migration runner/equivalence,
  `scripts/{smoke-sql,smoke-all}.mjs`, `packages/contracts/src/index.ts` only if inventory shape
  changes, and `docs/DATA_INVENTORY.md`.
- Chaos/gate/docs: `scripts/chaos-realtime-reconnect.mjs`, `scripts/verify.sh`,
  `tests/contract/verify-invocations.test.mjs`, `docs/DECISIONS.md`,
  `docs/architecture/10-10-platform.md`, `docs/{TESTING,STAGING_RUNBOOK}.md`,
  `monitoring/README.md`, parent plan/impact map, and W3.7 evidence.
- No Flutter/Web/Rust runtime source, realtime server wire/audio/admission/replay module, public
  route set, object writer, inference/Quran/auth/login/model/release routing, package/lockfile,
  Compose service/port, broker, or canonical ticket/ack fixture edit.

## Risks and rollback

- The v1 ambiguity rule sacrifices continuation to prevent both duplicate Quran audio and hidden
  loss. This is deliberate. W3.8 may approve a versioned idempotent frame envelope; W3.7 must not
  simulate exactly-once behavior without it.
- A caller can pessimistically mark its own session incomplete. It cannot mark another learner,
  replace a committed report, supply audio/transcript/identity, or create learner feedback;
  server-side lost outcomes remain independently authoritative and source-separated.
- Legacy clients do not report recovery. Their response is `unverified`; public cutover is forbidden
  until Flutter W4.11 implements the frozen contract and renders it honestly.
- Rollback removes the optional request/response handling and reference client. The additive columns
  remain inert and forward-compatible; no destructive down migration or data rewrite is allowed.

## Verification boundary

Focused policy tests are development feedback. Completion requires live Postgres RLS/finalization,
real Node WebSocket chaos, long-audio accounting, canonical `verify.sh`, reviewed exact diff, clean
synchronized branch, exact-final-SHA remote CI, evidence, and guarded ledger closure.

**APPROVAL RECORDED:** The repository owner approved continuation on 2026-08-09. Implementation is
limited to this exact failure policy and proof surface; any versioned wire, Flutter, batch-upload, or
traffic expansion requires its own approved later slice.

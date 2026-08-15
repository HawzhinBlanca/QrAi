# W3.6 plan — durable storage/index outcomes

**Status:** APPROVED — implementation proceeds one criterion slice at a time<br>
**Approved-by:** Repository owner — explicit “approved” on 2026-08-09<br>
**Criteria:** SIO-1…SIO-7; parent RT-3, RT-4

## Decision

Keep one byte writer (`audio-object-store`) and one playback index (`audio_chunks`). Extract the
current route's validation/idempotent insert into `server/src/storage/audio-index.mjs`, expressed as
domain outcomes rather than HTTP replies, so the HTTP route, Node realtime consumer, and operator
repair use identical identity, ownership, retention, object-key, span/rate, and conflict semantics.
The route remains the signed-ticket adapter; realtime passes only frozen admitted claims; repair
treats object metadata as a candidate, never authority.

Add migration `0037_realtime_audio_chunk_outcomes.sql` with one forced-RLS diagnostic table keyed by
`(tenant_id, session_id, chunk_id)` and structurally cascaded to the owning session. Store only the
immutable span/rate, initial `accepted-lost|stored-unindexed`, a closed reason code, first-observed
time, and nullable repaired time. Implementation research found one necessary ambiguity case: an
object-store timeout can hide a remotely committed conditional write, so a later verified repair may
close either initial outcome, including `accepted-lost`. Span/rate/outcome identity remains immutable.
No bytes, learner display data, ticket/nonce, exception, trace, URL, or caller-authored object key
belongs there. `audio_chunks` remains the sole playback authority; this table is diagnostic only.

After each W3.5 object-store attempt, the FIFO consumer invokes one injected outcome authority. A
retained successful put is indexed under the existing two-second database statement bound. A
discard put stays on the existing one-hour retention path and is not indexed by realtime. Store
failure records accepted-lost; retained index failure preserves the object and records
stored-unindexed where possible. Either failure closes the socket after the bounded outcome attempt
to stop orphan/loss growth. If Postgres is unavailable too, a separate fixed counter records that
durable diagnostic failure; no raw identity is logged and completion is never claimed.

Rewrite the repair command onto the shared index domain and restricted `withTenant` boundary. It
must recheck current session learner and retention, keep dry-run default, and in apply mode create
the index plus repaired provenance in one transaction. A repair discovered solely from object
inventory inserts a stored-unindexed diagnostic already marked repaired; rerun returns
already-indexed and changes no counters/timestamps.

## Test-first implementation sequence

1. Add red migration proof for the exact 0037 schema/checksum, constraints, forced RLS, cross-tenant
   refusal, session cascade, and privacy-safe columns. Add red runtime tests for the missing outcome
   authority and exact fixed labels. Run focused tests red and save the failure evidence.
2. Add the additive migration/manifest entry and its mechanical collateral: migration counts and
   convergence, smoke schema/RLS/live seed, contracts core-table inventory, cleanup, and data
   inventory. Do not modify historical migration bytes. Run focused migration proof then full gate.
3. Add red shared-domain cases for valid retained index, exact retry, immutable conflict, missing
   session, learner/retention disagreement, discard handling, RLS isolation, and no caller key.
   Extract the route transaction into `storage/audio-index.mjs`, adapt `indexAudioChunk`, and keep
   its exact HTTP status/body/parity behavior green before realtime integration.
4. Add red realtime cases for stored+indexed, stored-unindexed, accepted-lost, durable-record
   idempotency, lost aggregate, dual outage, rejection non-recording, fixed metrics/redaction, and
   socket close. Inject a complete authority into `createRealtimeAudioRuntime`; production creates
   it from the existing restricted DB, while admission/replay-only tests use explicit fakes.
   Amend Node finalization to union inference-reported missing IDs with durable accepted-lost IDs,
   so an already-recorded tail loss cannot be overwritten or double-counted.
5. Add red repair cases for current-retention mismatch, corrupt/incomplete object, index conflict,
   dry-run, atomic apply+repair provenance, inventory-only outage recovery, and idempotent rerun.
   Refactor `repair-audio-index.mjs` to the shared domain without changing its CLI/JSON contract.
6. Extend the real live-Postgres retention/storage/index/playback/repair E2E with the Node realtime
   path: ack remains enqueue-only; retained success becomes indexed/playable; discard is not
   advertised; outage leaves an intact object and no playback; repair makes audited playback work.
7. Pin the W3.6 suites exactly once in canonical verification and update ADR-0051/0052, architecture,
   testing, staging repair runbook, monitoring, data inventory, parent impact map, and evidence. Keep
   public routing, clients, Rust binaries, Compose topology, packages, and lockfile unchanged.
8. Before every code slice fetch origin and compare reserved paths with parallel work. After each
   slice run `bash scripts/verify.sh`; only after final focused/live/canonical proof, reviewed diff,
   clean synchronized branch, non-force push, exact-final-SHA required CI, and evidence may the
   guarded ledger command mark W3.6 done.

## Exact implementation surface

- New domain/runtime/schema/proof: `server/src/storage/audio-index.mjs`,
  `server/src/realtime/outcomes.mjs`, `infra/migrations/0037_realtime_audio_chunk_outcomes.sql`,
  `tests/migrations/realtime-audio-outcomes-migration.test.mjs`, and
  `tests/realtime/storage-index.test.mjs`.
- Existing writers/composition: `server/src/routes/recitation.mjs`,
  `server/src/routes/session-writes.mjs`, `server/src/realtime/{audio,main}.mjs`, and
  `server/scripts/repair-audio-index.mjs`.
- Regression/E2E callers: `tests/realtime/{backpressure,process-lifecycle,ticket-boundary,replay-protection}.test.mjs`,
  `tests/api-parity/audio-index-parity.test.mjs`, `tests/api-parity/audio-playback-parity.test.mjs`,
  `tests/api-parity/session-finalize-parity.test.mjs`, `tests/e2e/teacher-audio-index.test.mjs`,
  and relevant privacy/storage tests.
- Migration/inventory collateral: `infra/migrations/manifest.json`, migration runner/equivalence,
  `scripts/{smoke-sql,smoke-all}.mjs`, `packages/contracts/src/index.ts` plus its table test, and
  `docs/DATA_INVENTORY.md`. `infra/provision/app-role.sql` should remain generic; edit only if a red
  restricted-role test proves the current all-table grants do not cover 0037.
- Gate/docs/evidence: `scripts/verify.sh`, `tests/contract/verify-invocations.test.mjs`,
  `docs/DECISIONS.md`, `docs/architecture/10-10-platform.md`, `docs/{TESTING,STAGING_RUNBOOK}.md`,
  `monitoring/README.md`, parent plan/impact map, and W3.6 evidence.
- No package/lockfile, public route/enum, Compose service/port, client, Rust, inference, Quran-data,
  auth/login, AI-feedback, model/eval, release-routing, or canonical fixture edit.

## Risks and rollback

- S3 success followed by DB failure is irreducibly non-atomic. Strongly consistent object inventory,
  a fixed stored-unindexed signal, socket closure, and idempotent repair are the recovery contract.
- Store and DB can fail together. The runtime cannot durably write into an unavailable database;
  the distinct unrecorded counter plus forced socket failure prevents a false completeness claim,
  while W3.7 owns client reconnect/finalize fallback.
- Per-frame Postgres work can reduce throughput. Indexing remains off the socket callback in the
  bounded FIFO consumer; two-second server cancellation, current queue/byte caps, and W3.5 latency
  regressions must remain green. W3.8 still owns production-image load/soak.
- A diagnostic table can become a competing source of truth. Constraints and docs make it
  diagnostic only: playback reads `audio_chunks`, repair reads verified objects+sessions, and
  session deletion cascades diagnostics.
- Rollback removes realtime outcome/index composition and returns to W3.5 store-only behavior.
  Migration 0037 remains inert as an additive forward-compatible table; no destructive down
  migration or object deletion is allowed. Rust traffic never moves in W3.6.

## Verification boundary

Focused tests are development feedback. Completion requires live Postgres migration/RLS and Node
storage→index→playback→repair proof, canonical `verify.sh`, a clean synchronized branch, reviewed
exact diff, exact-final-SHA required remote CI, evidence, and guarded ledger closure. Until every
gate is green, W3.6 remains unchecked and unclaimed.

**APPROVAL RECORDED:** The repository owner approved the diagnostic schema, failure/socket
semantics, exact surface, and red-first sequence on 2026-08-09. Implementation remains bound to the
proof gates above.

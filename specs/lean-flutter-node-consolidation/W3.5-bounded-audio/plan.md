# W3.5 plan — bounded realtime audio runtime

**Status:** APPROVED — implementation proceeds one criterion slice at a time<br>
**Approved-by:** Repository owner — explicit “approved” on 2026-08-09<br>
**Criteria:** BAR-1…BAR-7; parent RT-2

## Decision

Add one dependency-free `server/src/realtime/audio.mjs` runtime and make it the production default
for the existing exact Node WebSocket route. Keep the frozen raw-binary input and strict
`audio.ack`; `accepted=true` means the bytes were reserved in a bounded FIFO, exactly as in Rust,
not that storage/index/analysis completed. One async consumer per session writes directly through
the existing object-store `put`; no inference code is imported into the socket process.

Freeze these reviewed bounds in code rather than add deployment knobs: 2 MiB application payload,
2 MiB + 64 KiB transport message, 8 retained chunks and 4 MiB retained bytes per session, 64 MiB
retained bytes process-wide, 100 active/draining sessions, 64 KiB outbound-ack buffer, and a
1,024-entry/six-hour process-local cursor cache. A store attempt receives a two-second abort signal.
Audio shutdown drains for at most the smaller of four seconds and the existing pre-force resource
budget, then aborts in-flight work, discards only unstarted queued work, catches late settlements,
and releases all accounting before the object store and DB close.

The Node shadow writes Rust-compatible 16 kHz PCM-labelled metadata with 480 ms spans because the
deployed raw wire carries no format fields. This ports the existing oracle boundary but does not
solve the Web compressed-codec or negotiated-rate gap. Those are named cutover blockers; public
traffic stays on Rust. W3.6 begins from the store outcomes here and adds durable indexed/lost/repair
states rather than introducing a second audio writer.

## Test-first implementation sequence

1. Add the first red `backpressure.test.mjs` cases around a paused injected store: exact slot,
   per-session byte, global byte, active-session, slow-ack-buffer, and fixed-ack bounds. Run the
   focused test to prove red, add the minimal pure runtime, then run canonical verification green.
2. Add red FIFO/safe-sequence cases: one consumer per session, accepted ordering, rejected sequence
   reuse, same-process reconnect continuation, late-close non-rewind, bounded cursor eviction, and
   safe-integer exhaustion. Implement only that cursor/queue behavior and re-run the full gate.
3. Add red storage-boundary cases for exact claims-derived metadata, raw-byte identity,
   create-only/idempotent `put`, two-second abort, success/failure counters, no exception/raw-audio
   logging, and explicit ingress-ack-before-store semantics. Compose the existing store directly;
   do not import inference runtime or index/domain code. Re-run the full gate.
4. Add red real-Fastify socket cases for empty/exact/over/transport/text behavior, duplicate and
   101st-session refusal, one ack per eligible binary input, and the measured 100-session profile:
   4 KiB each, zero wrong/missing acks, p95 `<250 ms`, no bound exceeded, all gauges return to zero.
5. Register `@fastify/websocket` with explicit 2 MiB + 64 KiB `maxPayload`, a generic error path,
   and an audio-aware `preClose`. Replace only the production default 1013 seam, combine audio
   metrics, require store `put`, and keep admission/replay before upgrade and production start
   non-overridable. Update all affected fake stores/handlers and re-run the full gate.
6. Add red shutdown proof: stop admission, close active sockets with a fixed restart code, drain or
   abort within the derived budget, ignore late store settlement safely, zero retained accounting,
   then close replay/store/DB in order. Preserve the existing outer hard deadline and re-run gate.
7. Update ADR-0051/0052 implementation notes, architecture/testing/monitoring/staging docs, parent
   W3.5/W3.6 ownership wording, exact-one verify guard, and the W3.5 evidence file. Keep Compose,
   manifests, lockfile, clients, Rust, storage implementation, migrations, and public routing clean.
8. Before every implementation step fetch origin and compare changed paths; if the parallel agent
   touched a reserved W3.5 surface, re-map/reconcile instead of overwriting. Finish with focused
   proof, `git diff --check`, `bash scripts/verify.sh`, clean status, reviewed diff, commit and push
   without force, and exact-final-SHA required CI. Only then use the ledger command for W3.5.

## Exact implementation surface

- New runtime/proof: `server/src/realtime/audio.mjs` and
  `tests/realtime/backpressure.test.mjs`.
- Runtime integration: `server/src/realtime/main.mjs`; reuse
  `server/src/realtime/protocol.mjs` and `server/src/storage/audio-object-store.mjs` unchanged. Any
  defect requiring either file needs a plan amendment and renewed approval before editing.
- Regression callers: `tests/realtime/{ticket-boundary,process-lifecycle,replay-protection}.test.mjs`
  and `tests/contract/realtime-decisions.test.mjs`. Preserve the explicit injected 1013 seam where
  a test is solely about admission/replay; exercise the live default only in bounded-audio proof.
- Gate: `scripts/verify.sh` and `tests/contract/verify-invocations.test.mjs`, exactly once in the
  hermetic Node test command.
- Living docs/evidence: `docs/DECISIONS.md`, `docs/architecture/10-10-platform.md`,
  `docs/{TESTING,STAGING_RUNBOOK}.md`, `monitoring/README.md`, parent plan/tasks/impact map, and
  `specs/lean-flutter-node-consolidation/evidence/W3.5-bounded-audio.md`.
- No `package.json`, lockfile, Compose, migration, contract fixture, Web, Flutter, Rust, inference,
  Quran-data, auth, AI-feedback, or public/release routing edit.

## Risks and rollback

- Queue slots alone allow unsafe memory growth with 2 MiB frames; retained-byte budgets include
  queued and in-flight buffers, and every reserve/release branch is asserted at exact boundaries.
- Immediate acceptance can later become store failure. Metrics make that gap observable, docs forbid
  completion claims, and traffic cannot move until W3.6 adds durable outcome/repair states.
- `ws.maxPayload` at 2 MiB would erase the app-level rejection ack; the 64 KiB transport slack is
  deliberate and pinned against the Rust oracle. A slow reader can instead grow outbound memory,
  so the ack-buffer ceiling closes that socket rather than promise an impossible ack.
- A cursor cache can lose continuity on restart or eviction. Object-store create-only conflict
  prevents overwrite, but not loss; W3.7/W3.8 must prove a durable/versioned reconnect design before
  cutover. W3.5 claims only FIFO and same-process monotonicity.
- Browser WebM/MP4 and 24/48 kHz cannot be identified from raw frames. This plan records the gap and
  forbids cutover instead of inventing metadata. A later approved wire/client plan must resolve it.
- Rollback restores the 1013 default handler and removes the new runtime/tests/docs. Stored objects
  are ordinary existing-format objects and need no destructive rollback; Rust traffic never moves.

## Verification boundary

Focused tests are development feedback. Completion requires the hermetic W3.5 proof plus canonical
verification, a clean synchronized branch, reviewed exact diff, exact-final-SHA required remote CI,
and the ledger update. Until every gate is green, W3.5 remains unchecked and unclaimed.

**APPROVAL RECORDED:** The repository owner approved these semantics, numeric bounds, surface, and
sequence on 2026-08-09. Implementation remains bound to the red-first and proof gates above.

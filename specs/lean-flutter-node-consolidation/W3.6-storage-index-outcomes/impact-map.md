# W3.6 impact map — durable storage/index outcomes

Serena resolved the Node symbols and direct references before planning. Its JS server omitted some
test imports and cannot index Rust, so exact `rg` and read-only source inspection supplement this map.

| Symbol/surface to touch | Direct callers and consumers | Planned effect | Regression obligation |
|---|---|---|---|
| new `storage/audio-index.mjs` domain | HTTP `indexAudioChunk`; realtime outcome authority; repair command | one claims/candidate validation, derived key, session/consent check, idempotent insert/conflict authority | HTTP parity, realtime retained index, repair and RLS cases |
| `routes/recitation.mjs::indexAudioChunk` | route registry; gateway/canary/privacy-smoke callers; audio-index parity | retain ticket/body adapter and exact statuses/body; delegate DB effect | all valid/expired/forged/mismatch/span/retry/conflict cases unchanged |
| `realtime/audio.mjs::storeChunk` | one FIFO per active Node session; W3.5 pure/live tests | consume put result, invoke bounded index/loss outcome, close on store/index failure, preserve release/drain | ack-before-outcome, FIFO/bounds, failure/timeout/close/metrics tests |
| new `realtime/outcomes.mjs` | `createRealtimeApplication`; injected runtime tests | retained index, accepted-loss diagnostic, fixed outcome rendering; no raw logs | real DB state, dual outage, redaction, stop/late-settlement proof |
| `createRealtimeApplication/startRealtimeProcess` | production entrypoint; process/ticket/replay/backpressure helpers | construct authority from existing restricted DB; allow explicit test fake only | production seam non-overridable, fake completeness, close order unchanged |
| migration 0037 diagnostic table | realtime authority; repair; session privacy deletion; smoke/contracts/data inventory | constrained forced-RLS per-chunk accepted-lost/stored-unindexed + repaired time | checksum, columns/checks, cross-tenant refusal, cascade, no sensitive fields |
| `repairAudioIndex/reconcileCandidate` | package command, operations Compose profile, teacher-audio E2E | reuse shared domain/withTenant, recheck current retention, atomic repair provenance | CLI JSON compatibility, dry-run/apply/rerun/refusal/inverse orphan |
| `session-writes.mjs::prepareSessionFinalization` / `recitation_sessions.lost_chunk_count` | finalization job/response; Rust/Node parity; Flutter model | apply idempotent per-diagnostic loss/repair deltas; at finalization union unrepaired loss IDs with inference missing IDs so tails survive without double-count or later repair erasure | exact tail/overlap/no-overwrite/repair-delta; existing complete/gapped finalization remains green |
| `audio_chunks` and `review.mjs::audioStatus/getFindingAudio` | teacher/learner review, feedback gate, playback parity | remain sole availability/playback authority; no public enum change | no index=no playback; repair enables integrity/retention-checked audited playback |
| verification/docs | local/CI gate, operators, later W3.7–W3.9 implementers | exact-one W3.6 live proof, alerts/runbook/ADR/no-traffic boundary | invocation guard, decision/topology/documentation tests |

## Migration and privacy collateral

- Manifest moves from 35 to 36 entries; fresh applies 36, legacy-0021 applies 16, and legacy-0027
  applies 10. Historical checksums remain byte-identical and 0037 receives its own hard pin.
- Add the table to schema/RLS smoke and `CORE_TABLES`; update cleanups that enumerate tenant tables.
  Provisioning currently grants all public tables after migration and should need no special grant.
- The table references `(tenant_id, session_id)` with `ON DELETE CASCADE`, so existing learner
  session erasure removes it structurally. Privacy manifests already name the session/object; no
  raw outcome metadata or learner display data is exported.
- The parallel privacy branch modifies audit export/erasure. W3.6 does not use `audit_events` for
  delivery state and must fetch/reconcile before any shared privacy documentation change.

## Explicitly unaffected callers

- `server/src/storage/audio-object-store.mjs` remains the only byte writer and keeps create-only,
  checksum, retention, privacy, S3/filesystem, and key-derivation semantics.
- Admission, ticket fixtures, durable replay, binary/ack wire, queue/byte/session limits, and
  `accepted=enqueued` remain unchanged. No post-store ack or new public message is introduced.
- Rust gateway/platform API remain traffic targets/oracles and byte/code unchanged. Web/Flutter
  clients, reconnect/buffering, codec/rate negotiation, and stop/finalize fallback remain W3.7+
  work and cutover blockers.
- No package/image/service/port/broker, public route/enum, inference/model/eval, Quran bytes, Arabic
  regex, auth/login, AI feedback, canonical fixture, or release-routing change.

## Parallel-work reservation after approval

- Reserve the two new Node modules, migration 0037/manifest and migration tests, realtime
  `audio/main`, recitation route, repair command, W3.6 proof/E2E, verify guard/runner, and W3.6 docs.
- Fetch origin before each slice. If another agent changed a reserved path, stop that slice, inspect
  the exact diff, re-run Serena/reference mapping, and reconcile without overwriting or reverting it.

# W3.8 impact map — production-image realtime proof

Serena is unavailable in this session. Exact definitions/imports/callers were mapped with `rg` and
read-only source inspection; every listed consumer remains a regression obligation.

| Symbol/surface to touch | Direct callers and consumers | Planned effect | Regression obligation |
|---|---|---|---|
| `AUDIO_LIMITS` / `createRealtimeAudioRuntime` | `realtime/main.mjs`; backpressure/storage/recovery tests; architecture/metrics docs | add exact 15,360-byte PCM frame contract while preserving transport, queue, sequence, outcome, and shutdown bounds | exact/wrong/empty/app/transport sizes, no sequence advance, FIFO, 100/101, storage/outcome/recovery |
| Node `createRealtimeTicket` sample-rate selection | route registry, Node parity harness, Web/Flutter API clients, ticket audit row | return only `[16000]` regardless of unsupported requested rates | default/mixed/unsupported requests, audit persistence, auth/RLS/idempotency parity |
| Rust `create_realtime_ticket` handler sample-rate selection | platform API router and direct/parity tests | preserve public issuer parity during the observation window | Node/Rust exact response parity and existing ticket signature/retention proof |
| `RealtimeSessionTicket.allowedSampleRates` / OpenAPI response | TS consumers/tests, Flutter model/client, future generated clients, route completeness | narrow advertised output to the truthful single rate without changing ticket bytes | contract build/type tests, OpenAPI completeness, Flutter JSON/recorder tests |
| Flutter `StreamingRecorder.sampleRate` contract/comment | Practice screen and live/device tests | consume the one truthful ticket rate; framing redesign remains W4.11 | no device/recovery behavior change; consent/mic lifecycle tests stay green |
| new realtime image evidence policy | operator runner, release reviewers, W3.9 entry gate, evidence note | strict candidate identity, stages, profiles, thresholds, expiry, redaction, write-once refusal | positive reconstruction plus every identity/mutation/failure/fixture/expiry/refusal case |
| new actual-image probe/runner | release selection, Compose CLI, platform ticket/finalize routes, Node/Rust sockets, metrics, S3/Postgres, repair command | deterministic parity/hostile/retention/fault/load/soak against running immutable containers | command-plan unit tests, bounded timeouts, restoration/cleanup, no raw data or secret output |
| fault outcome/repair accounting | `realtime_audio_chunk_outcomes`; `repair-audio-index.mjs`; evidence validator and W3.9 reviewers | repair only observed stored orphans; preserve genuinely absent accepted loss and unresolved client uncertainty as actionable, and never report their recording complete | exact closed equation, outcome-class and uncertainty mutation tests, idempotent second pass, privacy-safe aggregate output |
| proof-only Compose overlay | base/release/native overlays, Compose config tests, Docker CI | publish Node candidate on loopback only with explicit proof resource bounds | rendered topology keeps Rust 8081/public target and one shared Node image; no source build in release mode |
| Docker workflow smoke | production image build, server/Compose path filters, remote PR checks | boot and attack the built realtime command without minting a completion artifact | non-root, health, valid/invalid ack, hostile survival, cleanup; workflow syntax/path tests |
| canonical verify invocation | all local/CI gates and invocation guard | run the W3.8 evidence contract exactly once | no duplicate/omitted or hidden release-only test; existing W3.1–W3.7 gates unchanged |
| ADR/architecture/testing/staging/monitoring/evidence | operators, W3.9/W4.11/W7.6 implementers, reviewers | freeze profile and completion authority; retain explicit client/traffic blockers | decision/topology/doc guards reject unsupported codec/rate or premature cutover claims |

## Explicitly unaffected callers

- `rt_v2` ticket bytes, Rust-generated ticket/ack fixtures, seven-field `audio.ack`, HMAC, replay
  hashing, Origin/native rules, admission bucket, storage keys, retention vocabulary, RLS, and
  recovery accounting remain byte/semantics compatible except for exact frame eligibility.
- `server/src/realtime/main.mjs` composition and public API/worker entrypoints keep their process and
  dependency boundaries. No new runtime package, broker, schema, service image, or image key appears.
- Web remains on its existing compressed MediaRecorder path and cannot be routed to Node realtime.
  W3.8 adds no transcoder and makes no investment in the client scheduled for retirement.
- W4.11 must implement PCM buffering/reframing, fresh-ticket recovery, bounded capture, and honest
  UI. W3.9 must independently canary/rollback. W7.6 alone removes Rust after observation.
- Canonical Quran bytes/regex, auth/login posture, feedback/source/review gates, inference/model/eval
  claims, and learner data migrations are outside this slice.

## Parallel-work reservation

- Current Git is clean and synchronized at planning start; recent commits are W3.7 closure only.
- Reserve the exact audio/rate files, new W3.8 proof files, verify invocation, Docker workflow,
  Compose proof overlay, and W3.8 docs during each slice. Fetch and compare before editing.
- If the parallel agent touches a reserved path or changes release/realtime assumptions, stop that
  slice, inspect both intents, amend this map, and merge without overwriting, reverting, amending, or
  absorbing unrelated work.

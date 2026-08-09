# W3.5 impact map — bounded realtime audio runtime

Serena resolved the Node symbols and direct references before planning; because its JS language
server omitted several cross-file `.mjs` test imports and does not support Rust/Dart, exact `rg` and
source inspection supplemented the caller map.

| Symbol/surface to touch | Direct callers and consumers | Planned effect | Regression obligation |
|---|---|---|---|
| new `createRealtimeAudioRuntime` / fixed bounds | `createRealtimeApplication`; new pure/live proof; future W3.6 store/index consumer and W3.7 reconnect | bounded session registry, FIFO workers, retained-byte accounting, same-process cursor, strict acks, fixed metrics, bounded stop | exact slot/byte/global/session/sequence/store/metrics/drain tests |
| `defaultAdmittedSocket` default | `createRealtimeApplication` only (Serena); production `startRealtimeProcess` reaches it transitively | replace 1013-only default with audio runtime handler; keep injectable close seam for admission/replay-only tests | live bounded default plus exact-route/frozen-context/generic admission regressions |
| `createRealtimeApplication` | `startRealtimeProcess` (Serena); ticket/process/replay tests (exact imports) | construct/validate runtime, explicit WS max payload/error/pre-close, require store `put`, combine audio metrics | W3.2 lifecycle, W3.3 boundary, W3.4 replay, W3.5 socket/shutdown suites |
| `@fastify/websocket` registration | every realtime route and raw-upgrade helper | reduce default 100 MiB to 2 MiB + 64 KiB; close oversize/slow peers generically; audio-aware shutdown | transport near-miss/over-limit/liveness and process close proof |
| `renderMetrics` | private `/metrics`; process lifecycle/monitoring/decision consumers | append fixed session/ingress/store series and gauges only | exact names/outcomes/counts plus identity/error/secret/audio redaction scan |
| `startRealtimeProcess` / shutdown phase input | realtime entrypoint, spawned lifecycle fixture, Compose command | production-only real store/runtime composition; drain budget derived inside existing grace | boot/readiness/failure isolation/SIGTERM/close-order proof |
| object-store construction contract (`put`) | real FS/S3 store; fake stores in ticket, process, replay, and W3.5 tests | require the method W3.5 consumes; no store implementation change | update every fake; existing storage/readiness/privacy suites remain green |
| strict `createAudioAck` / `serializeAudioAck` (reuse) | currently protocol fixture only; new runtime becomes first production caller | centralize exact seven-field ack and safe-sequence validation; no second serializer | all Rust vectors plus runtime accepted/rejected/trace/null cases |
| W3.3 default-1013 assertions/docs | ticket/process lifecycle tests; ADR-0052; architecture/testing | retain historical W3.3 statement, add implemented W3.5 bounded default/no-traffic statement | decision guard distinguishes historical admission proof from current runtime |
| replay-only application helpers | `tests/realtime/replay-protection.test.mjs` live/injected cases | inject explicit close handler where audio is irrelevant so replay tests never hang or consume storage | all W3.4 race/restart/outage/load/hash/cleanup behavior unchanged |
| `scripts/verify.sh` / invocation guard | local canonical gate, CI, release evidence | run W3.5 proof exactly once in hermetic Node command | exact-one assertion and full canonical gate |
| ADR/architecture/testing/staging/monitoring/parent docs | operators, reviewers, W3.6–W3.9/W4.11 implementers | record exact bounds, ack/store semantics, no-traffic state, format/recovery blockers, rollback | realtime decision contract and evidence review |

## Explicitly unaffected callers

- `server/src/realtime/{admission,replay}.mjs` and `server/src/lib/ticket.mjs` keep validation,
  durable claim order, no-nonce admitted context, ticket wire/HMAC, and fixed admission outcomes.
- `server/src/storage/audio-object-store.mjs` remains the sole create-only audio store. API, worker,
  inference, review, privacy export/delete, retention, and repair callers keep the same contract.
- `services/realtime-gateway` remains byte/code unchanged as traffic target and compatibility oracle.
  Its known unbounded global memory and restart-cursor limitations are not copied as Node claims.
- Web `startGatewayAudioUpload`/`PlatformCommand` and Flutter `StreamingRecorder` remain unchanged;
  their rejection recovery and format negotiation gaps remain explicit W3.7/W4.11/cutover blockers.
- Compose exposes no Node realtime host port; proxy/release selection still targets Rust. No schema,
  package, image, broker, Quran bytes, auth/login, model/eval, or learner-feedback path changes.

## Parallel-work reservation after approval

- Reserve `server/src/realtime/{audio,main}.mjs`, the W3.5 proof, the three realtime regression
  suites, verification guard/runner, realtime decision docs, and W3.5 evidence for this slice.
- Fetch and compare origin before each task. If another agent changed a reserved path, stop that
  task, inspect the exact diff, re-run Serena/reference mapping, and reconcile without overwriting.

# W3.5 specification — bounded realtime audio runtime

**Status:** approved for implementation under `plan.md`<br>
**Parent criterion:** RT-2<br>
**Primary proof:** `tests/realtime/backpressure.test.mjs`

## Scope

W3.5 replaces the internal Node shadow's admitted-but-unavailable socket seam with one bounded,
FIFO audio-ingress runtime. It preserves the Rust-generated binary/ack wire, writes queued bytes
through the existing object-store boundary, and exposes honest ingress/store outcomes. Rust remains
the only public traffic target; client recovery, durable loss/index state, and cutover remain later
gates.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| BAR-1 | WHEN an admitted client sends a binary WebSocket message, THE Node runtime SHALL accept at most 2,097,152 bytes, SHALL permit at most 2,162,688 bytes at the transport boundary so near-limit application refusals receive an `audio.ack`, SHALL reject an empty payload without consuming sequence, SHALL ignore text like the Rust oracle, and SHALL close a message beyond the transport ceiling without retaining it. | hostile/empty/exact/over/transport/text cases in `tests/realtime/backpressure.test.mjs`; Rust protocol regressions |
| BAR-2 | WHEN clients send faster than storage can finish, THE runtime SHALL retain at most 8 chunks and 4,194,304 audio bytes per session, 67,108,864 audio bytes globally, and 100 active/draining sessions; every admitted binary message within the transport ceiling SHALL receive one accepted or rejected strict `audio.ack` unless a bounded slow-consumer close is required, and the 101st session SHALL be refused without allocating an audio queue. | paused-store slot/byte/global/session/slow-peer cases in `tests/realtime/backpressure.test.mjs` |
| BAR-3 | WHEN frames are accepted, rejected, drained, disconnected, or reconnected in the same process, THE runtime SHALL deliver accepted frames to one per-session consumer in FIFO order, mint a nonnegative safe sequence and deterministic chunk id once, advance only after enqueue, reuse a rejected sequence, never rewind from a late close, and fail closed before safe-integer exhaustion. | FIFO/reorder/rejection/reconnect/late-close/exhaustion cases in `tests/realtime/backpressure.test.mjs` |
| BAR-4 | WHEN a frame is enqueued, THE `accepted=true` acknowledgment SHALL mean ingress acceptance only; THE consumer SHALL attempt the existing create-only object-store `put` with claims-derived tenant/learner/session/retention, fixed 16 kHz/480 ms oracle metadata, raw bytes, and a bounded abort signal, while store success/failure SHALL remain separate and SHALL NOT be advertised as recording completion or indexing. | ack-timing/metadata/idempotency/timeout/store-outcome cases in `tests/realtime/backpressure.test.mjs`; storage regressions |
| BAR-5 | WHEN overload, storage failure, socket close, or process shutdown occurs, THE runtime SHALL expose only fixed-cardinality ingress/session/store counters plus active/retained gauges, SHALL include no ticket/nonce/audio/tenant/learner/session/chunk/error label, SHALL close sockets and release queued bytes before object-store close, and SHALL finish or abort audio drain inside the existing process grace budget without an unhandled rejection. | metrics/redaction/close/drain/abort/order cases in `tests/realtime/backpressure.test.mjs` and `tests/realtime/process-lifecycle.test.mjs` |
| BAR-6 | WHEN 100 real local WebSocket sessions concurrently enqueue one 4 KiB frame through the production handler with a paused store, THE runtime SHALL start all 100, produce 100 correct acknowledgments with p95 send-to-ack below 250 ms, remain within every declared retained-byte/session bound, reject session 101, and return all gauges to zero after release and close. | measured 100-session profile in `tests/realtime/backpressure.test.mjs` |
| BAR-7 | WHEN canonical verification and living topology are inspected, THE W3.5 proof SHALL run exactly once, Node SHALL add no package/image/service/port/broker/public traffic edge, W3.1–W3.4 admission/replay guarantees SHALL remain intact, and Rust/Web/Flutter wire consumers SHALL remain unchanged for later parity/recovery work. | `tests/contract/verify-invocations.test.mjs`; `tests/contract/realtime-decisions.test.mjs`; ticket/replay/process/topology regressions |

## Non-goals and stop conditions

- No public route or proxy change, Rust removal, client edit, reconnect/backoff/fallback, durable
  accepted-lost/index/repair state, inference work, new schema, package, broker, service, or image.
- `accepted=true` does not mean stored, indexed, analyzed, or complete. W3.6 owns durable outcome
  state and W3.7/W4.11 own client recovery; W3.5 traffic movement is forbidden.
- The raw-binary wire does not carry codec/sample-rate metadata. The Rust-compatible 16 kHz/480 ms
  assumption and the Web MediaRecorder compressed-codec mismatch remain explicit W3.8 cutover
  blockers; W3.5 SHALL NOT claim browser-format or 24/48 kHz correctness.
- No Quran corpus, Arabic regex, login posture, learner feedback, model/evaluation, source/review,
  retention vocabulary, ticket bytes, or canonical fixture mutation.

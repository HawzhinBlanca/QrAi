# W3.8 specification — production-image realtime proof

**Status:** approved for implementation under `plan.md`
**Parent criteria:** RT-1, RT-2, RT-3, RT-4
**Primary proof:** `tests/release/realtime-image-evidence.test.mjs` plus release-bound artifacts

## Scope

W3.8 closes the gap between strong source-process tests and the image that would actually receive
native realtime traffic. It freezes one truthful audio profile, compares the immutable Node
candidate with the preserved Rust oracle, exercises hostile inputs, retention, faults, capacity,
load, and soak, and produces strict candidate-bound evidence. It does not move traffic; W3.9 owns
the independent switch and rollback, and W4.11 owns the Flutter recovery/framing implementation.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| RPI-1 | WHEN either API issues a realtime ticket, THE response SHALL advertise only `[16000]`; THE realtime contract SHALL define the one supported profile as mono signed PCM16LE at 16,000 Hz; WHEN Node receives a binary frame, THE runtime SHALL accept it only when it contains exactly 480 ms/15,360 bytes, SHALL retain the existing 2 MiB application and 2 MiB+64 KiB transport ceilings as hostile-input guards, and SHALL reject an invalid frame without advancing sequence. | `tests/api-parity/realtime-ticket.test.mjs`; contract tests; `tests/realtime/backpressure.test.mjs`; Flutter recorder contract test |
| RPI-2 | WHEN candidate-image proof starts, THE runner SHALL require a clean checkout whose full SHA equals the release selection, immutable registry references, matching running image IDs, the one shared Node backend image for API/worker/realtime, the selected Rust oracle identity, non-root execution, production S3 storage for release proof, and a rendered topology hash; THE proof-only Node port SHALL bind loopback and SHALL NOT replace Rust port 8081 or any public route. | identity/topology/refusal cases in `tests/release/realtime-image-evidence.test.mjs`; `tests/contract/http-canary-topology.test.mjs`; production-image tests |
| RPI-3 | WHEN the Node candidate and Rust oracle receive separately issued single-use tickets for the same valid profile, THE proof SHALL compare signature/session/tenant/retention/expiry/origin/replay outcomes and the exact seven-field acknowledgement shape; valid shared cases SHALL agree, diagnostic message text SHALL remain non-authoritative, and Node's deliberate stricter invalid-frame refusal SHALL be recorded rather than hidden as parity. | parity/admission stages in the actual-image runner; ticket/ack fixture, ticket-boundary, replay, and Rust hostile regressions; evidence-stage contract test |
| RPI-4 | WHEN hostile tickets or empty, text, wrong-sized, app-limit, transport-limit, oversized, burst, duplicate-session, slow-peer, or session-101 inputs reach the production image, THE boundary SHALL refuse or acknowledge them according to the frozen policy, SHALL account for every in-ceiling binary frame exactly once as accepted or rejected, SHALL stay alive, SHALL not exceed declared session/queue/byte/ack bounds, and SHALL return retained gauges to zero. | hostile/capacity stages in the actual-image runner; `tests/realtime/backpressure.test.mjs`; `tests/gateway/ws-hostile-input.test.mjs`; evidence-stage contract test |
| RPI-5 | WHEN discard, teacher-review, and training-opt-in sessions traverse the production image, THE proof SHALL verify claims-derived retention, immutable storage metadata, retained-only index/playback, actual retention cleanup, and privacy-safe evidence; IF Node, Postgres, or storage is interrupted, THEN fresh-ticket recovery or honest finalization SHALL account for every frame, durable lost/orphan state SHALL remain actionable, restored repair SHALL be idempotent, readiness SHALL fail closed while unsafe, and no incomplete recording SHALL be reported complete. | retention/fault/recovery stages in the actual-image runner; storage-index, teacher-playback, retention, replay, and recovery regressions; evidence-stage contract test |
| RPI-6 | WHEN the immutable candidate runs the frozen profiles, THE capacity profile SHALL serve 100 sessions with one valid frame each at send-to-ack p95 <250 ms and refuse session 101; THE 5-minute classroom profile SHALL serve 25 sessions at one frame/480 ms with 15,625 accounted frames; THE 100-session burst SHALL account for all 5,000 frames and exhibit bounded explicit backpressure; THE 30-minute soak SHALL serve 10 sessions and 37,500 frames with p95 <250 ms, p99 <500 ms, zero unexpected rejection/loss/restart/OOM, final gauges zero, peak RSS <512 MiB, end-minus-baseline RSS <=96 MiB, and RSS slope <=1 MiB/min. | load-policy/refusal cases in `tests/release/realtime-image-evidence.test.mjs`; measured capacity/classroom/burst/soak artifacts from the actual-image runner |
| RPI-7 | WHEN W3.8 evidence is created or accepted, THE schema SHALL bind source SHA, release selection, Node/Rust references and image IDs, topology, storage class, exact closed stages, commands, output digests, measurements, thresholds, start/end/expiry, and actor/environment class; output SHALL be owner-only and write-once, failures SHALL remain failed, evidence SHALL expire within 24 hours, and fixtures/source runs/mutable tags/skips/hand-authored metrics SHALL be ineligible. Canonical verification SHALL run the W3.8 contract exactly once; completion additionally requires the real same-candidate release artifact, exact-SHA remote CI, clean synchronized Git, and guarded ledger closure. | strict positive/mutation/refusal/expiry/write-plan tests in `tests/release/realtime-image-evidence.test.mjs`; `tests/contract/verify-invocations.test.mjs`; release CLI refusal tests |

## Non-goals and stop conditions

- No public proxy/DNS/port target change, canary cohort, rollback execution, Rust deletion, Flutter
  recovery implementation, Web codec conversion, or traffic claim. W3.9/W4.11/W7.6 own them.
- No Opus/WebM/MP4 support, rate negotiation, second audio writer, broker, new runtime dependency,
  service image, schema migration, inference/model/evaluation change, or learner-facing AI output.
- The current Flutter recorder may emit arbitrary device chunks and the retiring Web client emits a
  compressed container. Both remain blocked from Node traffic until W4.11 reframes PCM and W3.9
  admits only an approved client cohort. A synthetic/reference probe is not a product-client claim.
- A canonical green test or short Docker smoke does not substitute for the full 30-minute
  release-candidate soak and fault evidence. A failed threshold blocks W3.8; it is not averaged away.

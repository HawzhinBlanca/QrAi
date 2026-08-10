# W3.8 research — immutable realtime image parity, format, fault, and load

**Status:** research only; no runtime or test behavior changed
**Target:** W3.8 / RT-1–RT-4 / release-bound realtime evidence
**Method:** Serena is unavailable; `rg` caller searches plus exact source inspection were used and
the fallback is recorded rather than inventing symbol results.

## Implementation finding — loss is not fabricated repair

The production outcome and repair authorities distinguish two materially different states. A
`stored-unindexed` orphan still has immutable audio bytes and can be indexed idempotently. An
`accepted-lost` row produced by a definitive object-store failure has no audio bytes to recreate;
it must remain an actionable loss and the recording must remain incomplete. Therefore W3.8 evidence
must close the repair equation as `repaired + outstandingActionable = durableLost + durableOrphan`,
with stored orphans repaired and genuine loss left actionable. Treating every lost frame as repaired
would fabricate recovery and contradict `server/scripts/repair-audio-index.mjs`.

## Grounded boundary and data flow

- `server/src/realtime/main.mjs::{parseRealtimeConfig,createRealtimeApplication,startRealtimeProcess}`
  composes strict admission, replay, bounded audio, outcomes, readiness, metrics, and shutdown.
- `server/src/realtime/audio.mjs::{AUDIO_LIMITS,createRealtimeAudioRuntime}` accepts arbitrary
  non-empty binary messages up to 2 MiB but assigns every message 16 kHz and 480 ms. Only 15,360
  bytes of mono PCM16LE actually represent that span; odd, short, compressed, and long frames are
  therefore stored with false timing today.
- `server/src/routes/recitation.mjs` and Rust
  `services/platform-api/src/handlers/recitation.rs` advertise 16/24/48 kHz, while the realtime
  ticket carries no rate and Node always stores 16 kHz. `packages/contracts` preserves the drift.
- Flutter `StreamingRecorder` emits mono PCM16 at the ticket's first rate but does not frame it to
  480 ms; its test deliberately selects 48 kHz. Web `liveRecitation.ts` sends MediaRecorder
  WebM/Opus or MP4 bytes. W4.11 owns the Flutter recovery/framing port; React is being retired.
- `protocol.mjs`, Rust-generated ticket/ack fixtures, `ticket-boundary.test.mjs`,
  `backpressure.test.mjs`, replay/storage tests, and `realtime-recovery.test.mjs` provide strong
  source-process proof, including 100 local sockets at p95 <250 ms, but no immutable image proof.
- `tests/gateway/ws-hostile-input.test.mjs` is the real Rust-process oracle. It covers the hostile
  ticket corpus, empty/text/1-byte/exact/oversized frames, 50-frame bursts, and process survival;
  it does not prove Node or a release image.

## Release, topology, and evidence

- `server/Dockerfile` is one digest-locked non-root Node image for API, worker, and realtime.
  `docker-compose.release.yml` consumes one immutable `NODE_BACKEND_IMAGE` for all three roles.
- Base Compose exposes Node realtime only inside the network and publishes Rust on host port 8081;
  the native overlay only permits missing Origin. The canary overlay changes HTTP upstreams, not
  realtime traffic. W3.9, not W3.8, owns routing and rollback.
- `scripts/{http-canary-image,lib/http-canary-image}.mjs` has useful clean-SHA, image-ID, topology,
  and write-once patterns, but its probes/k6/schema are HTTP-only and cannot label WebSocket proof.
- `scripts/chaos-realtime-reconnect.mjs` uses API-issued fresh tickets and closed recovery
  accounting, but targets arbitrary source endpoints and creates no image-bound artifact.
- Docker is available locally. The Docker CI builds the production image and checks non-root and
  API health only; it neither starts `node-realtime` nor exercises protocol, retention, faults, or
  load from the built image.

## Planning constraints and risks

- Freeze one lean native v1 profile—mono signed PCM16LE, 16 kHz, exactly 480 ms/15,360 bytes—before
  load. Keep 2 MiB/transport ceilings as hostile-input guards; reject unsupported frame lengths and
  stop advertising 24/48 kHz instead of adding codec negotiation or a second audio pipeline.
- Record Rust parity for the valid shared profile and explicit, safer Node divergence for invalid
  frame shapes; changing public Rust traffic or its oracle implementation is out of scope.
- A proof-only loopback port may expose the candidate container for an isolated runner, but normal
  Compose, Web, Flutter behavior, public DNS/proxy traffic, and Rust port 8081 must remain unchanged.
- Evidence must bind clean full source SHA, selected registry digest, running image ID, rendered
  topology hash, Rust oracle identity, production storage mode, exact stage commands/outputs, and
  closed metrics without tickets, audio, learner/session IDs, tokens, or hand-authored results.
- A short hermetic image gate can run in CI; the required 30-minute soak and dependency/storage
  fault drill must run against the same release candidate in isolated staging. W3.8 cannot close
  on validator fixtures, source tests, a mutable tag, skipped live cases, or a passing CI smoke alone.
- Quantitative policy should preserve p95 ack <250 ms, require exact ack/outcome accounting and zero
  silent loss, prove 100-session capacity, bound retained gauges, reject session 101, return gauges
  to zero, and reject restart/unbounded-memory evidence. Thresholds must be frozen before execution.

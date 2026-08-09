# W3.7 research — realtime reconnect and honest fallback

**Date:** 2026-08-09
**Method:** Serena is not exposed in this session; exact definitions, imports, callers, fixtures, and
tests were mapped with `rg` plus read-only source inspection before planning.

## Current path

- Node W3.5 acknowledges `accepted=true` at bounded enqueue, assigns server-only sequence/chunk id,
  and W3.6 later records indexed, stored-unindexed, accepted-lost, or repaired outcomes.
- The frozen wire is raw binary client→server plus a seven-field JSON `audio.ack`; a client frame has
  no idempotency key. Replaying a sent-but-unacknowledged frame can therefore duplicate audio, while
  discarding it can lose audio. Exactly-once recovery is impossible on this wire.
- Node preserves sequence only for same-process reconnect. Durable ticket replay is single-use, so
  every WebSocket attempt must mint a fresh ticket.
- Finalization already unions inference gaps and unrepaired accepted-lost ids into
  `lostChunkCount`, but `finalized=true` can coexist with loss and there is no client capture report.
- Flutter `StreamingRecorder` mints one ticket, sends arbitrary PCM stream events without reading
  acknowledgements, buffering, reconnecting, or reporting loss. W4.11 explicitly owns its redesign.
- Web `startGatewayAudioUpload` re-tickets and buffers 125 items, but has no byte bound or ack window,
  drops oldest frames, resets retries on any open, never stops capture on degradation, and invokes no
  finalizer. Web is temporary and scheduled for deletion, so hardening it is throwaway work.
- `scripts/chaos-realtime-reconnect.mjs` targets Rust, mints tickets locally, duplicates the policy,
  counts sends rather than acknowledged frames, and can pass with loss. It is not in `verify.sh`.

## Required boundary

- Freeze a language-neutral recovery policy: equal-jitter retries (500 ms base, 15 s cap, six
  attempts), a 125-chunk and 2 MiB dual buffer ceiling, one in-flight frame, and fresh ticket per
  attempt. A connection becomes healthy only after a valid accepted acknowledgement.
- Never replay an ambiguous in-flight frame on v1. Stop capture, count it as uncertain, explain the
  incomplete recording, and finalize. Reconnect is safe only with no ambiguous frame.
- Buffer overflow, retry exhaustion, malformed/out-of-order acknowledgement, and rejected-frame
  exhaustion are terminal degraded states: stop capture before accepting more bytes and finalize
  once. No drop-oldest policy is allowed for learner audio.
- Add an optional bounded recovery report to the existing finalization request. Persist exact
  captured/acknowledged/dropped/uncertain counts plus fixed state/reason on the owning session as an
  immutable first report, and return `recordingStatus=complete|incomplete|unverified`. Authenticate
  before parsing and accept this client-capture truth only from the owning learner; staff retain
  legacy empty-body finalization. Never accept audio, transcript, ticket, tenant, learner, or
  arbitrary diagnostics in that report.
- Client uncertainty has no shared id with server accepted-loss, so the two sources cannot be
  deduplicated. Keep source-separated counts and derive integrity status; never invent a summed
  “total lost” that may double-count one frame.
- Preserve `finalized` as alignment-work status for compatibility; it must not be interpreted as a
  complete recording when `recordingStatus` is not `complete`.
- Use a real Node recovery client only as executable contract/chaos proof. W4.11 ports the frozen
  policy into Flutter after W3.8 freezes PCM framing/rate; React receives no new production work.

## Dependencies and exclusions

- W3.1–W3.6 are complete prerequisites. W3.8 image/codec/rate/soak, W3.9 traffic, and W4.11 Flutter
  device/UI/physical-network integration remain open.
- No public traffic move, Rust/Flutter/Web runtime edit, new route, audio writer, raw-audio log,
  Quran/model/auth/login change, broker, package, service, port, or destructive migration belongs
  in W3.7.
- Parallel privacy branches do not currently overlap the reserved W3.7 paths; fetch and re-diff
  before each implementation slice.

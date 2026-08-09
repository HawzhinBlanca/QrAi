# W3.5 bounded audio runtime — research

## Grounded current state

- RT-2 requires a bounded queue and explicit backpressure; W3.5 additionally names frame,
  payload, active-session, ordering, overload-metric, hostile-input, and 100-session proof.
- `server/src/realtime/main.mjs` owns the one internal Node realtime process. Admission and durable
  replay precede `101`; its default handler closes `1013` and no audio runtime exists.
- `server/src/realtime/protocol.mjs` is strict but runtime-unused: seven exact fields, safe sequence,
  boolean acceptance, diagnostic message, and always-present nullable/nonblank trace.
- Pinned `@fastify/websocket` 11.3.0 supports `options.maxPayload`, but Node supplies none; pinned
  `ws` therefore permits 100 MiB messages. Rust permits 2 MiB audio and 2 MiB + 64 KiB transport.
- The existing object-store boundary already rejects bytes above 2 MiB and provides create-only,
  idempotent/conflict-safe FS/S3 `put`; realtime construction currently requires only ready/close.
- `renderMetrics` has only process/admission/replay series; close has no audio-session close,
  queued-byte release, worker drain, or abort phase before object store/DB closure.

## Oracle and clients

- Rust defaults are queue 8, 16 kHz, 480 ms. `accepted=true` means enqueued, not stored; a full queue
  is rejected without advancing its process-local, restart-unsafe sequence cursor.
- Rust caps each payload but has no active-session or global queued-byte cap: 8 worst-case payloads
  retain about 16 MiB per session. Its 100-session test only pins local enqueue p95 under 150 ms.
- Rust hostile proof covers empty, exact/over application limit, transport close, ignored text,
  50 rapid acks, and process liveness; the burst is not deterministic backpressure proof.
- Web sends WebM/Opus or MP4 blobs, keeps a 125-item disconnected drop-oldest buffer, and displays
  ack acceptance, but continues sending after rejection. Flutter sends PCM16, neither reads acks
  nor reconnects, and mints one ticket. W3.7/W4.11 own honest recovery/client flow control.
- Ticket claims handed to the socket omit nonce and negotiated sample-rate metadata. Node can retain
  the current 16 kHz oracle default, but cannot honestly infer 24/48 kHz or browser codec semantics.

## Caller and regression map

- Replacing `defaultAdmittedSocket` affects `createRealtimeApplication`, production start, and
  lifecycle/ticket/decision tests that explicitly pin `1013`; amend those guards without weakening
  exact-route, frozen-context, generic refusal, replay-before-upgrade, or no-traffic assertions.
- Application fakes in `ticket-boundary`, `process-lifecycle`, and `replay-protection` omit store
  `put`; replay-only tests that leave the default handler live can otherwise hang.
- Web and Flutter practice/recorder/gateway callers exist; no client edit belongs in W3.5.
- Verification has no W3.5 target; the new proof needs one exact invocation and guard assertion.

## Decisions the approved W3.5 plan must freeze

- Preserve the frozen wire: binary input, diagnostic-only prose, `accepted=enqueued`, rejection does
  not consume sequence, text parity, 2 MiB application and 2 MiB + 64 KiB transport ceilings.
- Add both slot and byte bounds per session, one global queued-byte budget, an active-session cap,
  fixed-cardinality outcomes, a bounded store attempt, and audio-runtime stop before store closure.
- Keep FIFO sequence authority process-local in W3.5 and state that restart durability is unproven;
  W3.6 owns durable stored/indexed/lost states and W3.7 owns reconnect/fallback/no-loss behavior.
- Resolve the master wording by making W3.5 queue consumers write through the existing object-store
  boundary only; no index/repair/domain-state claim is allowed until W3.6.
- Red-first proof must use a paused injected store for deterministic backpressure/FIFO, then real
  Fastify sockets for empty/limits/text/close/101st-session/100-session memory-latency-shutdown.
- Numeric queue-byte/global-byte/session/latency/RSS/drain bars are absent today and must be explicit
  in the owner-approved plan; traffic remains on Rust until later image/load/canary gates.

## Parallel-work boundary

- Research ran on clean `134b9a7`, aligned with origin; no other worktree or uncommitted overlap was
  visible. Before implementation, fetch safely, re-map callers, and reserve W3.5 surfaces.

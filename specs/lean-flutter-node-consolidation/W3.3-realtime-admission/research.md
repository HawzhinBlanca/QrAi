# W3.3 research — realtime admission and ticket parity

**Status:** research complete; child plan owner-approved<br>
**Target:** W3.3 / RT-1 / `tests/realtime/ticket-boundary.test.mjs`

## Current symbols and behavior

- Serena maps `server/src/realtime/main.mjs::{parseRealtimeConfig,createRealtimeApplication,
  startRealtimeProcess}` to the W3.2 internal Fastify process. It exposes health/readiness/metrics
  and a raw `upgrade` listener that returns 404 for every socket.
- `server/src/lib/ticket.mjs::validateRealtimeTicket` already matches Rust `rt_v2`: exact session,
  non-empty tenant/learner/retention/nonce, boolean text, unsigned-`u64` expiry, HMAC verification,
  and expiry. Its existing caller is `routes/recitation.mjs::indexAudioChunk`.
- `server/src/lib/admission.mjs::createTokenBucketLimiter` already supplies the required 200 burst,
  one-token/50 ms refill, 10,000-key ceiling, idle/LRU eviction, and bounded retry. Its current
  caller is the Node HTTP `createApplication`; W3.3 can reuse it unchanged.
- Rust `realtime-gateway::{validate_origin,check_ticket,audio_ws}` is the oracle: browser Origin is
  exact-allowlisted, native no-Origin is separately enabled, signed claims bind session and tenant,
  expiry lifetime is capped at 3,600 seconds, then replay is checked. Replay remains W3.4 scope.
- Rust carries all three signed retention values and an optional trimmed `trace_id`. Unknown signed
  non-empty retention remains privacy-safe downstream; W3.3 must not invent a second enum authority.

## Callers, fixtures, and proof gaps

- `packages/contracts/fixtures/realtime/rt-v2-ticket-vectors.json` has six Rust-generated vectors,
  including Unicode, empty-secret crypto, every retention value, and maximum `u64` expiry.
- `tests/gateway/ws-hostile-input.test.mjs` is a real Rust-process oracle, but its malformed-ticket
  corpus is local to that file. A small shared test-case builder can make Rust and Node execute the
  identical named admission cases without moving runtime authority out of Rust.
- `tests/realtime/process-lifecycle.test.mjs` and `tests/node-api/production-image.test.mjs` pin the
  refusal-only source and internal no-traffic Compose topology. They must change with admission,
  while Web/Flutter and the public Rust gateway target remain unchanged.
- The Node realtime Compose role does not yet receive ticket secret, tenant, Origin, native-policy,
  rate, or trusted-proxy configuration. The native overlay configures only the Rust gateway.
- Canonical verification has no W3.3 suite or exact-once invocation assertion.

## Selected dependency and constraints

- Node 22 has no production WebSocket server in this package. Hand-writing handshake/framing would
  create a second protocol stack. The official `@fastify/websocket` plugin is built on `ws@8`, uses
  Fastify routes and pre-upgrade hooks, and participates in server close. Official documentation:
  <https://github.com/fastify/fastify-websocket>.
- Registry inspection on 2026-08-08 found current `@fastify/websocket` **11.3.0** (MIT), depending on
  `ws ^8.16.0`; current `ws` is 8.21.3. Pin the direct plugin exactly and let the frozen lockfile pin
  transitives. This is a new runtime dependency and therefore requires ADR-0052 plus audit/licence/
  production-image proof.
- The plugin must register before routes so rejected upgrades remain HTTP refusals. Admission runs
  in a pre-upgrade hook using Fastify's peer/trusted-hop `request.ip`; no raw ticket enters logs,
  metrics, persistence, or the admitted connection context.
- W3.3 accepts only the exact audio route. A valid shadow upgrade immediately closes as temporarily
  unavailable and processes no message; W3.5 replaces that fail-closed handler with bounded audio.
- Fixed admission outcome counters may expose accepted/origin/ticket/rate classes only. No tenant,
  learner, session, trace, Origin, ticket, URL, or exception label is permitted.

## Scope boundary

- In scope: signature/session/tenant/retention/expiry/max-lifetime validation, Origin/native policy,
  bounded IP admission, real 101 proof, strict boot config, shared hostile cases, and closed metrics.
- Out of scope: replay mutation/schema/benchmark (W3.4), audio/frame/queue/ack handling (W3.5),
  storage/indexing (W3.6), reconnect clients (W3.7), public traffic, Rust removal, or client edits.

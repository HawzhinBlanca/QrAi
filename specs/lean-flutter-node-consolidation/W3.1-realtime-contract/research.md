# W3.1 research — language-neutral realtime protocol and security decision

**Status:** research only; no runtime or test behavior changed<br>
**Method:** Serena is unavailable in this session, so symbol/reference mapping used read-only `rg`
and exact source inspection. **Target:** W3.1 / RT-1 / approved W0–W7 consolidation plan.

## Real symbols and current behavior

- `server/src/lib/ticket.mjs::{ticketPayload,signTicketPayload,issueRealtimeTicket,
  verifyRealtimeTicket,validateRealtimeTicket,newNonce}` is the Node issuer/validator. Its wire is
  `rt_v2` plus seven dot-delimited payload fields and lowercase HMAC-SHA256; expiry is a `BigInt`
  because Rust accepts the full unsigned-64-bit range.
- Pre-implementation red testing found that the Node issuer accepted negative and above-`u64`
  `BigInt` expiries, minting signed tickets the Rust validator can never parse. RTC-2 therefore
  requires a mint-time domain guard while preserving every valid wire byte and oracle vector.
- `services/shared-ticket/src/lib.rs::{TICKET_VERSION,RealtimeTicketClaims,TicketError,
  issue_realtime_ticket,validate_realtime_ticket}` is the Rust oracle used by both Rust services.
  `services/shared-ticket/tests/regenerate_vectors.rs` is the Rust-only fixture generator.
- `specs/node-backend-port/fixtures/ticket-vectors.json` has six Rust-generated vectors and is read
  directly by `tests/node-api/ticket-vectors.test.mjs` and Rust's `ticket_vectors` test module.
  Its location and N1 wording are transitional rather than language-neutral final ownership.
- `services/realtime-gateway/src/lib.rs::{validate_origin,check_ticket,audio_ws,
  handle_audio_socket,AudioIngressAck,serialize_ack}` owns upgrade admission and the JSON ack.
  Admission verifies signature/session/expiry/max lifetime/tenant, then consumes the ticket.
- `GatewayServerState.consumed_tickets` is a per-process raw-ticket map. `RealtimeGateway::
  redis_mark_ticket` adds cross-instance SHA-256-keyed Redis `SET NX EX`; configured Redis can fail
  closed, while absent Redis deliberately leaves only per-process replay protection.
- `AudioIngressAck` emits exact snake-case keys `kind,session_id,chunk_id,sequence,accepted,
  trace_id,message`. Sequence advances only after an accepted bounded-channel send.

## Consumers and data flow

- `server/src/routes/recitation.mjs::createRealtimeTicket` reads stored tenant/session/learner,
  consent/retention and mints the opaque token returned by the strict OpenAPI ticket response.
- Web: `fetchRealtimeTicket` → `startGatewayAudioUpload`; reconnects mint a fresh token, buffer
  oldest-first, and `parseGatewayAudioAck` validates all ack fields except optional `trace_id`.
- Flutter: `PracticeScreen` → `StreamingRecorder`; it constructs one ticketed socket before opening
  the microphone and streams PCM unchanged, but does not parse acknowledgments or re-ticket yet.
- Scripts and tests consuming the boundary include gateway smoke/hostile/retention/index-failure,
  teacher-audio E2E, API parity, Flutter recorder tests, and Web live-recitation tests.
- Canonical gate runs Node ticket vectors, Rust shared-ticket tests, and a real hostile WebSocket
  process. Existing fixtures do not yet pin ack serialization cross-runtime.

## Risks and planning constraints

- Never generate protocol truth from the new Node consumer; preserve the Rust-generated ticket
  oracle until both implementations pass one shared fixture, then retain the fixture after Rust.
- Moving the fixture must update both hard-coded readers and generator output atomically; copying it
  would create two authorities. Only declared test tickets/secrets belong in fixtures; production
  raw tickets/secrets must never enter a fixture, database, log, or replay record.
- Ack `message` currently embeds Rust error display strings and is not a safe permanent semantic
  enum. Freeze accepted/backpressure protocol semantics without making incidental prose authority.
- Flutter's test uses an opaque `rt_v1.token`; it does not exercise wire parsing and can hide stale
  examples. Flutter ack/reconnect work belongs to W4.11, not this contract-only task.
- W3.1 may accept the ADR and freeze fixtures only. Node process, Postgres replay table, upgrade
  handling, backpressure, and traffic movement belong to W3.2–W3.9 and need their own red tests.
- The original coarse master-plan W3.1 paragraph assigned entrypoint, admission, and replay work to
  this slice, while the approved ledger decomposes those into W3.2–W3.4. The master plan now records
  that superseding allocation instead of leaving two active scopes.

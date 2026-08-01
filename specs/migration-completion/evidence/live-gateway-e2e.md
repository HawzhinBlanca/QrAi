# The Flutter client's audio transport against a live gateway

**2026-08-02.** The practice flow had never run against a real `realtime-gateway`. Every test to that
point injected either the socket or the PCM stream, so what was proven was ordering and routing —
not that the ticket `platform-api` mints is one the gateway accepts.

Re-runnable: `apps/flutter/test/live_gateway_test.dart`, gated on `QRAI_LIVE_TICKET` so it skips in
`verify.sh` rather than failing a runner with no stack.

## What ran

```bash
# platform-api against the Docker Postgres from scripts/stack.env
ALLOW_INSECURE_SECRETS=1 ALLOW_HEADER_AUTH=1 \
CORS_ALLOWED_ORIGINS=http://localhost:5202 PLATFORM_API_BIND=127.0.0.1:8083 \
  ./services/platform-api/target/debug/quran-ai-platform-api

# realtime-gateway, configured for a NATIVE client (see "Two refusals" below)
ALLOW_INSECURE_SECRETS=1 GATEWAY_ALLOW_MISSING_ORIGIN=1 GATEWAY_TENANT_ID=tenant-demo \
REALTIME_GATEWAY_BIND=127.0.0.1:8086 REALTIME_GATEWAY_TICKET_SECRET=smoke-secret \
  ./services/realtime-gateway/target/debug/quran-ai-realtime-gateway

# a session and a ticket, through the real API with a real HS256 token
curl -X POST .../v1/recitation-sessions      -> session-7a1a061a-de93-4266-b96a-a8e36df8dd16
curl -X POST .../v1/realtime-session-tickets -> rt_v1.session-7a1a061a-….ddc2e43d…

export QRAI_LIVE_TICKET="$(cat ticket.json)" QRAI_LIVE_GATEWAY=http://127.0.0.1:8086
cd apps/flutter && flutter test test/live_gateway_test.dart
```

## Result

```
gateway replied 5 message(s); first: {"kind":"audio.ack",
  "session_id":"session-7a1a061a-de93-4266-b96a-a8e36df8dd16",
  "chunk_id":"session-7a1a061a-de93-4266-b96a-a8e36df8dd16-ws-0000",
  "sequence":0,"accepted":true,"trace_id":null,"message":"accepted"}
All tests passed!
```

Five 20 ms PCM16 frames sent through `StreamingRecorder`; five acks, `accepted: true`. Three
independently written pieces agreeing — Rust signs the ticket, Rust verifies it, and this client
only ever handles it as an opaque string.

## Two refusals on the way, and both were the gateway being right

**1. `403 — CSWSH check failed: missing Origin header`.** A browser always sends `Origin` on a
WebSocket upgrade; a native client sends none, and the gateway fails closed rather than let the
allowlist be bypassed by omitting a header. `lib.rs:749` already names this case — *"Accepting a
MISSING Origin is what a native/Flutter client actually needs"* — and gives it
`GATEWAY_ALLOW_MISSING_ORIGIN=1`, which relaxes **only** that branch: a request that does carry an
Origin is still checked, so browsers keep their protection.

> **Deployment requirement.** Any deployment serving the Flutter client must set
> `GATEWAY_ALLOW_MISSING_ORIGIN=1`, or **every recitation returns 403**. This was found by running
> it; nothing in the repo would have told you.

**2. `401 — realtime ticket tenant 'tenant-demo' does not match gateway tenant 'hikmah-pilot-erbil'`.**
The gateway is pinned to one tenant via `GATEWAY_TENANT_ID`. Working as designed — a ticket from
another tenant is refused at the transport, not merely at the data layer.

## What this does NOT prove

- **Nothing ran on a phone.** The transport ran on the Dart VM under `flutter test`. `FL9` is open.
- **No microphone was involved.** The PCM stream was injected; `record`'s hardware path has still
  never executed.
- The audio was silence. Nothing downstream — alignment, tajweed — was exercised.

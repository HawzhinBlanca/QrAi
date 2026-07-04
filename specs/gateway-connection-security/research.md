# Research — Realtime Gateway 10/10 Hardening (Client Pooling & CSWSH Protection)

We mapped the implementation details for reusing a single HTTP client and adding Origin verification to `realtime-gateway`.

## Relevant Files / Symbols
- [services/realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
  - `GatewayServerState`: The Axum state structure passed to route handlers.
  - `gateway_router`: Constructs the routing table and server state.
  - `audio_ws`: Handles WebSocket upgrade requests, currently extracting only the query parameters and path.
  - `handle_audio_socket`: Spawns the tokio audio forwarding task that performs HTTP POST requests to `ml-inference`.

## Current Behavior
1. **HTTP Client:** At line 620, a new `reqwest::Client` is created for every new WebSocket connection:
   ```rust
   let client = reqwest::Client::new();
   ```
   This prevents global socket pooling across sessions.
2. **Origin Validation:** In `audio_ws` (line 460), the client's `Origin` header is completely ignored, exposing the service to potential Cross-Site WebSocket Hijacking (CSWSH) if signed tickets are intercepted or replayed by user browsers on malicious domains.

## Integration Points
- Add `http_client: reqwest::Client` to `GatewayServerState`.
- Initialize the shared client in `gateway_router` using a default builder.
- Inside `handle_audio_socket`, use `state.http_client.clone()` instead of `reqwest::Client::new()`.
- Add an `origins` check against the `Origin` header or `headers` in the `audio_ws` Axum handler.

## Risks & Mitigations
- **Broken Tests:** Modifying state or router construction might affect unit tests.
  - *Mitigation:* Ensure `GatewayServerState` remains `Clone` and `gateway_router` retains the same public signature `pub fn gateway_router(config: GatewayServerConfig) -> Router`.
- **Axum WebSocket Upgrade Headers:** Accessing headers in Axum's `WebSocketUpgrade` route requires adding the `HeaderMap` extractor to `audio_ws`.
  - *Mitigation:* Simply add `headers: HeaderMap` as a parameter to the Axum handler.
- **Permissive Local Dev vs Strict Prod:** Local dev / smoke tests might run from arbitrary origins (or none, e.g. Node tests).
  - *Mitigation:* Fall back to accepting all origins if `ALLOW_INSECURE_DEFAULTS` is set, matching platform CORS behaviors.

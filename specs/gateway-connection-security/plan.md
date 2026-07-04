# Plan — Realtime Gateway 10/10 Hardening (Client Pooling & CSWSH Protection)

Approved-by: 

We will reuse a shared `reqwest::Client` in the realtime-gateway forwarding task and enforce strict Origin verification on WebSocket upgrades.

## Proposed Changes

### Realtime Gateway (Rust Service)

#### [MODIFY] [lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- Modify `GatewayServerState` to hold `http_client: reqwest::Client`.
- In `gateway_router`, construct a shared `reqwest::Client` and assign it to `GatewayServerState`.
- Modify the `audio_ws` Axum handler signature to extract `headers: HeaderMap`.
- Inside `audio_ws`, extract the `Origin` header. If `ALLOW_INSECURE_DEFAULTS` is not set/true:
  - If a comma-separated `CORS_ALLOWED_ORIGINS` environment variable is defined, verify the client's `Origin` is present in it. If not matching, reject the connection with `StatusCode::FORBIDDEN`.
  - If `CORS_ALLOWED_ORIGINS` is not defined (or empty), allow any origin in local development, but in production (when `ALLOW_INSECURE_DEFAULTS` is false), reject WebSocket upgrades lacking allowed origins or having mismatching origins.
- Inside `handle_audio_socket`, replace:
  ```rust
  let client = reqwest::Client::new();
  ```
  with cloning the shared client:
  ```rust
  let client = state.http_client.clone();
  ```

## Verification Plan

### Automated Tests
- Run `cargo test --manifest-path services/realtime-gateway/Cargo.toml` to verify the router build and WebSocket upgrade tests.
- Add a new integration/unit test in `realtime-gateway/src/lib.rs` verifying that WebSocket connection requests with disallowed/malicious origins are rejected, and those with allowed origins or in dev mode are accepted.
- Run `bash scripts/verify.sh` to ensure compile/build, fmt/clippy, and all tests pass.

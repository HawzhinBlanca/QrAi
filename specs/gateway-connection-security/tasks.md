# Tasks

- [x] Task 1: Re-use pooled reqwest client in realtime-gateway
  - [x] Add `http_client: reqwest::Client` to `GatewayServerState` in `services/realtime-gateway/src/lib.rs`
  - [x] Initialize `reqwest::Client` in `gateway_router` in `services/realtime-gateway/src/lib.rs`
  - [x] Update `handle_audio_socket` in `services/realtime-gateway/src/lib.rs` to clone the shared client from `state.http_client`
- [x] Task 2: Implement CSWSH protection via Origin header validation in realtime-gateway
  - [x] Update signature of `audio_ws` in `services/realtime-gateway/src/lib.rs` to extract `headers: HeaderMap`
  - [x] Implement validation logic for `Origin` against `CORS_ALLOWED_ORIGINS` when `ALLOW_INSECURE_DEFAULTS` is not set/true
- [x] Task 3: Add automated tests & verify
  - [x] Add unit test verifying that WebSocket upgrades are rejected with invalid origins and accepted with valid origins
  - [x] Run `bash scripts/verify.sh` to ensure all tests pass

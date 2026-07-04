# Impact Map — Realtime Gateway 10/10 Hardening

We map the affected symbols and functions for HTTP client pooling and CSWSH origin protection.

## Affected Symbols & Callers

### 1. `GatewayServerState`
- **File:** [services/realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- **Callers/Usage:**
  - Implements `Clone`.
  - Passed as state in `gateway_router` configuration.
  - Accessed by `audio_ws` and `handle_audio_socket`.

### 2. `gateway_router`
- **File:** [services/realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- **Callers/Usage:**
  - Called in `services/realtime-gateway/src/main.rs` at boot.
  - Called in test `builds_gateway_router_for_health_and_audio_websocket_routes` in `services/realtime-gateway/src/lib.rs`.

### 3. `audio_ws`
- **File:** [services/realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- **Callers/Usage:**
  - Router endpoint mapped to route `/v1/audio/:session_id`.

### 4. `handle_audio_socket`
- **File:** [services/realtime-gateway/src/lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs)
- **Callers/Usage:**
  - Called in `audio_ws` callback upon successful upgrade.

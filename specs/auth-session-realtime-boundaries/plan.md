# Auth, Session, and Realtime Boundaries Plan

Add a test validating the CORS origin boundary for the Platform API.

## User Review Required

> [!IMPORTANT]
> The test verifies that tower-http CORS restricts origin access as configured by the `CORS_ALLOWED_ORIGINS` environment variable.

## Proposed Changes

### Platform API Integration Tests

#### [MODIFY] [integration.rs](file:///Users/hawzhin/QrAi/services/platform-api/tests/integration.rs)
- Add a new test `test_platform_api_cors_origin_validation` that:
  - Sets `CORS_ALLOWED_ORIGINS=https://allowed.example.com`.
  - Sends requests with disallowed and allowed origin headers.
  - Verifies that CORS response headers (`access-control-allow-origin`) are only present and correct for allowed origins.

## Verification Plan

### Automated Tests
- Run the new CORS integration test:
  ```bash
  source scripts/stack.env && cargo test --test integration test_platform_api_cors_origin_validation
  ```
- Run the verify script:
  ```bash
  bash scripts/verify.sh
  ```

# Research: Load, Soak, and Chaos Testing

## Objectives
- Load, soak, and chaos test the staging environment.
- Run load tests while simulating network split and check error propagation and recovery without leaking data.

## Current Codebase Architecture
1. **k6 Load testing (`scripts/load-test.js`)**:
   - Targets critical paths of `platform-api` (`/health`, `/v1/quran/surahs`) and `ml-inference` (`/health`, `/v1/alignments:predict`, `/v1/tajweed-findings:predict`).
   - Defines strict latency thresholds (e.g. alignment p95 < 2s, other endpoints < 500ms).
   - Validates error rates (threshold < 1%).
   - Rate limiters on `ml-inference` (100 req/min per IP) naturally trigger rate limit error responses (429s) under multi-VU load.
2. **Network Split and Recovery (Chaos)**:
   - Evaluated by disconnecting the `ml-inference` container from the `quran-ai-staging_default` network.
   - Platform API properly reports readiness (HTTP 200) since database pool remains healthy.
   - Network recovery is verified by reconnecting `ml-inference` to the compose network and checking that containers are instantly back to healthy status.
3. **Container Healthchecks**:
   - Fixed web container Busybox `wget` healthcheck DNS resolution by targeting IPv4 loopback `127.0.0.1` directly (instead of `localhost`), resolving a recurrent container unhealthy status indicator.

## Compliance Summary
- Load test has been executed and verified.
- Chaos split and recovery sequence verified.

# Research: SLO Instrumentation

## Objectives
- Instrument SLOs, logging levels, and metrics.
- Ensure that readiness and health routes are implemented and checked in deployment scripts.

## Current Codebase Architecture
1. **Health and Readiness Endpoints**:
   - `services/platform-api` exposes `/health` (liveness) and `/ready` (readiness; checks Postgres DB pool connection health via `SELECT 1`).
   - `services/realtime-gateway` exposes `/health`.
2. **Log Instrumentation**:
   - Both `platform-api` and `realtime-gateway` support `LOG_FORMAT=json` for JSON-formatted logging in production environments, making them readily ingestible by log aggregators.
3. **Healthcheck Configuration in Docker Compose**:
   - `postgres`: Checked via `pg_isready`.
   - `platform-api`: Checked via `curl -f http://localhost:8080/ready` (checks Postgres health transitively).
   - `realtime-gateway`: Checked via `curl -f http://localhost:8081/health`.
   - `ml-inference`: Checked via `curl -f http://localhost:8090/health`.
   - `asr-inference`: Checked via `curl -f http://localhost:8091/health`.

## Compliance Summary
- Comprehensive health/readiness endpoints and container-level orchestration probes are configured and verified.

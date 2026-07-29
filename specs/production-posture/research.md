# Research: Production Posture

## Objectives
- Provision and verify production posture.
- Secure environment configuration, HTTPS validation, ingress settings, and network isolation configurations must be verified in build config and infra scripts.

## Current Codebase Architecture
1. **docker-compose.yml**:
   - Isolates `postgres` to loopback `127.0.0.1:5433:5432`.
   - Isolates `ml-inference` and `asr-inference` internally on the docker bridge network (no exposed ports to the host or internet).
   - Only `platform-api` (8080) and `realtime-gateway` (8081) ports are exposed.
2. **Environment & Secrets configuration**:
   - `ALLOW_INSECURE_DEFAULTS` defaults to `0` (enforcing strict authentication/cryptographic checks).
   - Boot-time secret validation ensures the service fails fast if `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`, or other keys are weak or default.
   - `scripts/gen-production-secrets.sh` automates generating cryptographically secure secrets via OpenSSL, storing them under gitignored, `chmod 600` files.
3. **Staging disposable environment script (`scripts/recreate-staging.sh`)**:
   - Fully destroys previous containers, rotates staging environment secrets, boots the containers, and verifies their readiness endpoints.

## Compliance Summary
- Port/network isolation is strictly enforced.
- Cryptographic configurations are locked down to prevent boot under insecure defaults.
- Secret rotation tool creates file handles with mode `600` and automatically rotates keys.

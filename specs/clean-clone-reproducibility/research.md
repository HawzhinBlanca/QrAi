# Research: Clean Clone Reproducibility

## Objectives
- Execute a clean-clone validation of build/test/run sequence.
- Guarantee 100% reproducibility of the release candidate.

## Current Codebase Architecture
1. **CODYSTEM Verify Gate (`scripts/verify.sh`)**:
   - Compiles and formats TS contracts, quran-data, and web packages.
   - Compiles and runs Cargo clippy / tests for realtime-gateway and platform-api.
   - Runs Hermetic Node services tests (`ml-inference`, `agents`).
   - Runs database integration tests when live Postgres is reachable, skipping safely (never faking) otherwise.
   - Runs production asset build and security sweep.
2. **CI workflow configuration (`.github/workflows/ci.yml` or similar)**:
   - CI uses `scripts/verify.sh` directly, executing the exact same reproducibility checks in a fresh clone for every push.

## Compliance Summary
- Build/test/run sequence is 100% reproducible via `scripts/verify.sh`.

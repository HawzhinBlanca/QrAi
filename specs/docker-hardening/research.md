# Research: Docker Hardening

## Objectives
- Harden builds and supply chains for ML, ASR, gateway, and platform-api.
- Verify production images use pinned tags, minimal base images (slim/alpine), and execute as non-root users.

## Current Codebase Architecture
1. **services/platform-api/Dockerfile**:
   - Uses `rust:1.96-bookworm` builder and `debian:bookworm-slim` runtime.
   - Runs as non-root `appuser` (uid 10001).
2. **services/realtime-gateway/Dockerfile**:
   - Uses `rust:1.96-bookworm` builder and `debian:bookworm-slim` runtime.
   - Runs as non-root `appuser` (uid 10001).
3. **services/ml-inference/Dockerfile**:
   - Uses `node:22-bookworm-slim` base.
   - Runs as non-root `appuser` (uid 10001) with chowned folders.
4. **services/asr-inference/Dockerfile**:
   - Uses `python:3.11-slim-bookworm` base.
   - Installs from pinned `requirements.lock.txt`.
   - Runs as non-root `appuser` (uid 10001).
   - Warm-caches Whisper base model during image build phase.

## Compliance Summary
- All 4 backend service containers are fully hardened to execute under restricted user privileges (uid 10001, no root execution), use slim/minimal base image tags, and pin their compiler/runtime tags.

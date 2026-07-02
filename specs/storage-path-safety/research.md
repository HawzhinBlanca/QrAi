# Storage Path Safety Research

## Current Behavior

- `services/ml-inference/server.mjs` builds local object-storage paths with `join(AUDIO_STORAGE_DIR, tenantId, learnerId)` and `join(tenantDir, chunkId)`.
- `requiredString()` only checks non-empty strings. It does not reject `..`, `/`, `\`, or NUL.
- `/v1/audio-chunks`, `/v1/privacy/export`, and `/v1/privacy/delete` all accept request-supplied tenant/learner/chunk IDs for filesystem paths.

## Risk

A malformed tenant, learner, or chunk ID can escape the intended tenant/learner directory or collide with another logical namespace. Even in the local smoke harness, retained audio is privacy-sensitive data and object-key boundaries must be explicit.

## Target Behavior

- Filesystem-backed storage path segments reject traversal markers and separators.
- Invalid storage IDs fail with HTTP 400 before touching the filesystem.
- Normal hyphenated UUID-like IDs continue to work.
- `pnpm smoke:privacy` proves malicious retained-audio IDs are rejected.

# Quran AI ML Inference Service

This is a local, dependency-free ML harness for smoke testing the planned Quran
AI inference boundary. It does not call external networks or API providers.

Endpoints:

- `GET /health`
- `POST /v1/alignments:predict`
- `POST /v1/tajweed-findings:predict`
- `POST /v1/eval-runs`
- `GET /v1/audit-events?tenantId=...`
- `POST /v1/privacy/export`
- `POST /v1/privacy/delete`

External ASR is represented by a local stub and is called only when:

- `externalAsrRequested` is `true`
- `consent.externalAsrProcessing` is `true`
- guardian consent is satisfied for child/private profiles
- the tenant is in `ML_EXTERNAL_ASR_TENANTS`

Non-opted-in requests stay local and are marked `teacher-review-required` when
`ML_LOCAL_MODEL_AVAILABLE` is not enabled.

Retained audio privacy behavior:

- `/v1/audio-chunks` writes an audio object plus a metadata sidecar for retained chunks.
- Filesystem-backed storage IDs (`tenantId`, `learnerId`, `chunkId`) must be safe
  path segments: no traversal markers, slashes, backslashes, NUL, whitespace, or
  shell-style path characters.
- `/v1/privacy/export` reports both `audioObjectKeys` and `metadataObjectKeys`.
- `/v1/privacy/delete` removes both object classes for the requested tenant/learner and
  reports `deletedAudioObjectKeys` plus `deletedMetadataObjectKeys`.

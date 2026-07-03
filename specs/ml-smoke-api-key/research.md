# ML Smoke API Key Research

## Target Surface

- `services/ml-inference/server.mjs`
  - Requires `x-ml-api-key` or `apiKey` query param for prediction, eval, audio, and privacy endpoints.
  - Defaults `ML_API_KEY` to `smoke-ml-api-key` for local smoke/dev.
- `scripts/smoke-ml.mjs`
  - Starts a local ML service when `ML_INFERENCE_SMOKE_URL` is not provided.
  - Calls ML predict/eval/audit endpoints without `x-ml-api-key`.
- `scripts/smoke-privacy.mjs`
  - Starts a local ML service when `ML_INFERENCE_SMOKE_URL` is not provided.
  - Calls ML predict/privacy/audio endpoints without `x-ml-api-key`.
- `scripts/smoke-all.mjs`
  - Runs `smoke:ml` and `smoke:privacy`; aggregate smoke failed because both scripts received `401 unauthorized`.

## Finding

`pnpm smoke:all` passed proof, SQL, browser, API, and gateway, then failed both ML-related steps:

- `smoke:ml`: `/v1/alignments:predict failed 401`
- `smoke:privacy`: `/v1/alignments:predict failed 401`

The smoke scripts did not send the API key required by the ML service. They should use the same local default as the service, while honoring `ML_API_KEY` for custom smoke environments.

## Acceptance Criteria

- WHEN `pnpm smoke:ml` starts the local ML service with default env, THE smoke client SHALL send `x-ml-api-key: smoke-ml-api-key`.
- WHEN `pnpm smoke:privacy` starts the local ML service with default env, THE smoke client SHALL send `x-ml-api-key: smoke-ml-api-key`.
- WHEN `ML_API_KEY` is set for smoke, THE smoke clients SHALL use that value in `x-ml-api-key`.
- WHEN aggregate smoke runs, THE ML and privacy steps SHALL no longer fail with `401 unauthorized`.

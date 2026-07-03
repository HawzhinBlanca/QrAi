# ML Smoke API Key Impact Map

## Changed Files

- `scripts/smoke-ml.mjs`
  - Adds a smoke client API key derived from `ML_API_KEY ?? "smoke-ml-api-key"`.
  - Sends the key on ML POST requests.

- `scripts/smoke-privacy.mjs`
  - Adds a smoke client API key derived from `ML_API_KEY ?? "smoke-ml-api-key"`.
  - Sends the key on ML POST requests.

## Test Coverage

- `pnpm smoke:ml`
- `pnpm smoke:privacy`
- `pnpm smoke:all`
- `bash scripts/verify.sh`

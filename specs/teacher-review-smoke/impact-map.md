# Teacher Review Smoke Impact Map

## Files

- `scripts/smoke-api.mjs`
  - Seeds a real audit event, word alignment, and tajweed finding for the smoke-created session through live Postgres.
  - Adds success-path coverage for `/v1/teacher-reviews`.
  - Tightens `/v1/teacher-review-queue` from array-shape only to non-empty seeded queue.

## Runtime Assumptions

- API smoke runs against the same live Postgres database used by the running Platform API.
- `psql` is available on `PATH`, at `PSQL`, or in the Homebrew PostgreSQL path used by `scripts/verify.sh`.

## Tests

- `pnpm smoke:api`
- `bash scripts/verify.sh`

# Teacher Review Smoke Research

## Current Behavior

- `scripts/smoke-api.mjs` posts `/v1/teacher-reviews` for `finding-smoke`.
- `finding-smoke` does not exist, so the expected result is `404`.
- The script then calls `/v1/teacher-review-queue` and only asserts that the response is an array.

## Risk

The proof checklist says API smoke checks teacher review behavior, but the smoke does not prove a valid teacher review can be written. It only proves the missing-finding guard and queue response shape.

## Target Behavior

- Keep the missing-finding `404` regression check.
- Seed a real word-alignment/tajweed-finding FK chain for the smoke-created session.
- Add a success-path teacher review against that real smoke-seeded finding.
- Assert the response has a review id.
- Keep the queue array check and require at least one seeded/pending item so the endpoint is not silently empty.

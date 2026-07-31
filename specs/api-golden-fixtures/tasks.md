# Tasks — golden API fixtures

Plan: `plan.md` (APPROVED 2026-07-30). Rows flip only via `scripts/update-ledger.sh` after
`verify.sh` exits 0 AND the stated acceptance is met.

- [x] F1 normalizer, tested standalone
- [x] F2 capture harness, two runs byte-identical
- [x] F3 failure-case coverage, asserted mechanically
- [x] F4 differ that fails on altered fixtures
- [x] F5 gated in verify.sh

## Result: 26 steps captured, 38 tests, all five green

| Task | Evidence |
|---|---|
| F1 | `scripts/lib/fixture-normalize.mjs`, 16 tests |
| F2 | 26 steps; `verify-fixture-determinism.sh` → byte-identical |
| F3 | 12 failure cases of 26; 8 coverage tests incl. a recorded 5xx gap |
| F4 | `diff-api-fixtures.mjs` → 26/26 match; 14 tests, most asserting it FAILS on altered input |
| F5 | F1/F3/F4 suites in `verify.sh` (no server needed) |

## Three problems the tests found, not reasoning

1. **Accumulating state.** The scenario creates a session, so list endpoints grew between runs and
   captures were not identical. A property of the SCENARIO — no value normalization can hide an
   extra array element. Fixed by a documented fresh-DB precondition, enforced by
   `verify-fixture-determinism.sh`.
2. **Ordinal placeholders do not survive replay.** `<ID:session#1>` vs `#2` is assignment-order
   dependent, so capture and replay legitimately disagree. Fixed with `comparePlaceholderEquivalent`
   — a consistent BIJECTION. It still catches a port that loses a reference, which is the failure
   that matters.
3. **The differ guessed auth from step names.** Fragile and it mis-routed steps. Auth headers are
   now RECORDED per step: a replay harness must not infer authorization from prose.

## Facts recorded about the API, not "fixed"

- `POST /v1/recitation-sessions` returns **200**, not 201.
- `POST /v1/pilot/session/bootstrap` returns **403**, not 401, for an unknown token.
- `/v1/auth/token` returns **snake_case** — captured with casing intact.
- An invalid `modelVersion` FK yields **500**, not a 400. Arguably a client error surfaced as a
  server error; noted, not changed.

Changing any of these is a separate, visible API decision — not something to slip into a migration.

## Known gaps, stated rather than implied

- **5xx variants uncovered.** `ApiError::Database` and `UpstreamUnavailable` need a broken DB or
  upstream. Asserted as a gap so the claim goes stale loudly if it changes.
- **Coverage is bounded by the scenario.** Routes reachable only from unusual states are missed.
- **DB-gated replay is not in `verify.sh`.** The always-runnable suites are gated; replaying against
  a live API needs a running server, which CI does not currently start.
- **Gateway/WebSocket not covered.** Different protocol; its HMAC ticket is coupled at cutover.

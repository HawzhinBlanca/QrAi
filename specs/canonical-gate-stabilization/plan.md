# Canonical Gate Stabilization — Plan

**Approved-by:** User approval in Codex task, 2026-07-25

## Approach

1. In `apps/web/src/App.smoke.test.tsx`, add one test-local helper that clicks
   Internal Command and uses Vitest's bounded `vi.waitFor` to assert that the
   localized command heading and the real `.capture-button` are present.
2. Replace the five duplicated `10 × 10 ms` loops with that helper. Preserve
   every existing post-ready assertion and all fake media/WebSocket behavior.
3. Do not change `App`, `InternalSurface`, `PlatformCommand`, production smoke,
   timeout configuration, or dependencies.

## Rationale

The existing test relies on a 100 ms import budget, while the production browser
smoke explicitly polls the same React.lazy boundary for up to 12 seconds. A
bounded assertion keeps failure visible while removing scheduler/cache timing as
a source of false red gates.

## Test-first evidence and verification

- Failing-first evidence is retained from the 2026-07-24 canonical-gate failure:
  the test observed the Internal Command loading state after its 100 ms loop.
- Run the focused App smoke suite immediately after the test-only change.
- Run the full web suite, then `bash scripts/verify.sh`.
- Do not call a release gate or revise release-readiness evidence: this is not a
  release certification change.

## Risks and controls

- **Risk:** masking an import regression. **Control:** bounded `waitFor` still
  fails if the command never renders and asserts the real capture control.
- **Risk:** weakening coverage. **Control:** preserve the five distinct existing
  scenarios and their current assertions.
- **Risk:** scope creep. **Control:** one test file only; no runtime change.

## Stop condition

Do not implement until a human fills the `Approved-by:` line above.

## Completion evidence

- 2026-07-25: T1 replaced five fixed 100 ms waits with the bounded helper.
- Focused App smoke: 23/23 passed.
- `bash scripts/verify.sh`: `VERIFY OK`; `scripts/update-ledger.sh T1
  app-smoke-internal-command` then marked T1 complete.

# Canonical Gate Stabilization — Specification

## Scope

Stabilize the web Internal Command smoke coverage. No learner-facing behavior,
API, authentication, model, or browser-smoke contract changes are in scope.

## Acceptance criteria

- **R1:** WHEN an App smoke test opens Internal Command, THE test SHALL wait for
  the lazy-loaded capture control through a bounded assertion rather than a
  fixed 100 ms sleep.
- **R2:** WHEN the lazy-loaded command fails to become ready within the bounded
  wait, THE test SHALL fail rather than proceeding with an undefined control.
- **R3:** WHEN the command becomes ready, THE existing capture, reconnect,
  cleanup, navigation, and segmented-control assertions SHALL continue to run.
- **R4:** WHEN this slice is complete, THE focused web suite and
  `bash scripts/verify.sh` SHALL pass without changing production behavior.

## Test mapping

| Criterion | Automated proof |
|---|---|
| R1, R2 | `App.smoke.test.tsx` shared Internal Command readiness helper and its five callers |
| R3 | Existing named Internal Command capture, double-click, unmount, related-tab, and segmented-control tests |
| R4 | `pnpm --filter @quran-ai/web test`; `bash scripts/verify.sh` |

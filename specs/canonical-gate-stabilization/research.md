# Canonical Gate Stabilization — Research

## Scope

Make the web internal-command smoke assertions deterministic without weakening the
real lazy-load coverage. This is the first implementation slice because the
canonical gate failed on this path during the 2026-07-24 audit.

## Relevant symbols and flow

- `App` → `AuthenticatedApp` in `apps/web/src/App.tsx` owns `activeSection` and
  renders `InternalSurface` for the admin route.
- `InternalSurface` in `apps/web/src/components/InternalSurface.tsx` lazy-loads
  `PlatformCommand`; its loaded heading is the localized
  `platformCommand.heading` value.
- `PlatformCommand` in `apps/web/src/components/PlatformCommand.tsx` is the
  capture UI under test; it exposes `.capture-button` only after the lazy import
  resolves.
- `apps/web/src/App.smoke.test.tsx` renders `App`, clicks Internal Command, then
  repeats a fixed 10 × 10 ms text poll in five tests before interacting with the
  capture controls.
- `App` publishes `#browser-smoke-report[data-has-command-hero]` for deployed
  browser smoke; `scripts/smoke-browser.mjs:waitForSmokeReport` already polls
  the same lazy-load condition for up to 12 seconds.

## Current behavior and evidence

- The 2026-07-24 full `verify.sh` run failed one web assertion while the DOM was
  still at the Internal Command loading state.
- A fresh targeted run and a fresh full web run on 2026-07-25 both passed
  (23/23 and 124/124), establishing timing sensitivity rather than a consistently
  missing feature.
- The localized heading remains present in `apps/web/src/locales/en.json`; it is
  a valid loaded-state signal, but the test's 100 ms budget is not deterministic.

## Affected callers / contracts

- Test-only: five internal-command cases in `App.smoke.test.tsx` share the
  fixed polling pattern and must move together to one bounded helper.
- Production browser smoke consumes the `hasCommandHero` DOM probe and must keep
  its current behavior; no production UI behavior or API contract should change.
- `PlatformCommand` capture, ticket, mic, reconnect, and cleanup assertions must
  remain intact after waiting is centralized.

## Risks

- A longer blind sleep could hide a genuine lazy-import regression; the helper
  must fail with useful DOM state inside a bounded timeout.
- Changing the readiness signal or lazy import could alter deployed browser smoke;
  avoid production-code changes unless the focused test proves they are needed.
- This repair makes only the ordinary gate deterministic. It does not claim
  release readiness, model evaluation, or human approval gates are complete.

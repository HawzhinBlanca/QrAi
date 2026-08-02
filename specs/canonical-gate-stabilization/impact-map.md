# Canonical Gate Stabilization — Impact Map

## Symbol to change

| Symbol / file | Direct callers | Planned action | Regression proof |
|---|---|---|---|
| New test-local `openInternalCommand` helper in `apps/web/src/App.smoke.test.tsx` | Five Internal Command scenarios at the current 100 ms polling blocks | Centralize click + bounded readiness assertion; remove duplicated fixed sleeps | All 23 App smoke tests |

## Symbols inspected, not changed

| Symbol / file | Callers / consumers | Why no change |
|---|---|---|
| `App` / `AuthenticatedApp` in `apps/web/src/App.tsx` | `main.tsx`, `App.smoke.test.tsx`, browser smoke | Production rendering and smoke report already express the correct lazy-load state. |
| `InternalSurface` in `apps/web/src/components/InternalSurface.tsx` | `App` | Owns the lazy `PlatformCommand` import; changing it would alter production behavior unnecessarily. |
| `PlatformCommand` in `apps/web/src/components/PlatformCommand.tsx` | `InternalSurface`, browser smoke, App smoke | Its `.capture-button` is the real post-load readiness signal and must remain unchanged. |
| `waitForSmokeReport` in `scripts/smoke-browser.mjs` | Admin browser-smoke case | Already uses a 12-second bounded poll; it validates the planned test approach but is not modified. |

## Search evidence

CCC search and direct reference search located all five duplicated fixed polls in
`App.smoke.test.tsx`, the lazy import in `InternalSurface.tsx`, and the deployed
browser smoke probe. Serena is not available in this execution environment, so
CCC plus direct symbol/reference search supplied the equivalent read-only map.

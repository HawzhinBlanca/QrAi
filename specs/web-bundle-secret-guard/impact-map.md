# Web Bundle Secret Guard Impact Map

## Files

- `apps/web/src/lib/auth.tsx`
  - Removes the dev auto-login account and associated bypass logic.

- `scripts/check-web-bundle-secrets.mjs`
  - Scans `apps/web/dist` for known dev credential/weak-secret literals.

- `scripts/verify.sh`
  - Runs the bundle scan after the web build.

- `apps/web/README.md`
  - Clarifies that login-on development uses the real login/register flow.

## Affected Callers

- Default learner preview is unaffected because `apps/web/src/App.tsx` still bypasses login unless `VITE_REQUIRE_LOGIN=1`.
- Login-enabled dev/prod now uses the explicit login/register screen instead of silent dev auto-login.

## Proof

- Red target: current `apps/web/dist` contains `dev-bypass-12345` and `bypass.local`.
- Green target: web build plus bundle scan passes, and `bash scripts/verify.sh` includes the scan.

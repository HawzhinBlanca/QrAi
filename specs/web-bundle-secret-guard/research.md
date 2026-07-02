# Web Bundle Secret Guard Research

## Current Behavior

- `apps/web/src/lib/auth.tsx` includes a dev auto-login account with `dev@bypass.local` and `dev-bypass-12345`.
- `bypassEnabled()` returns false in production builds, so the bypass does not run at runtime.
- The production Vite bundle still contains the dev email/password literals after `pnpm --filter @quran-ai/web build`.
- `scripts/verify.sh` guards tracked `.env`/secret files, but it does not scan built browser artifacts for dev credentials or weak secrets.

## Risk

Even disabled dev credentials should not ship inside browser JavaScript. A production bundle is user-downloadable, and retaining auth-bypass literals undermines the login-off/login-on boundary.

## Target Behavior

- The web production bundle contains no dev auto-login credentials.
- The app remains login-off by default for general users.
- If login is explicitly enabled, users see the real login/register flow; no hidden dev auto-login path remains.
- `bash scripts/verify.sh` fails if future web builds contain known dev credential/weak-secret literals.

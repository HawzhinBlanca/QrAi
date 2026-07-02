# Web Bundle Secret Guard Tasks

- [x] T1 Remove dev auto-login credentials from the browser bundle and add a production bundle secret scan. Tests: `pnpm --filter @quran-ai/web build`, `node scripts/check-web-bundle-secrets.mjs`, `bash scripts/verify.sh`

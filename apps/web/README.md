# @quran-ai/web

Learner + internal-console web app (React + Vite + TypeScript).

## Login is OFF by default (pilot/preview)

Per the product owner, general users reach the app with **no login** — no sign-in screen,
no `?smoke` param. See `docs/DECISIONS.md` ADR-0002.

- Default: `LOGIN_ENABLED = false` (in `src/App.tsx`) → renders directly with a default
  learner.
- **To enable login for production (owner-authorized only):** build with
  `VITE_REQUIRE_LOGIN=1`.

## Dev

```bash
npx -y pnpm@11.7.0 --filter @quran-ai/web dev        # http://127.0.0.1:5201
npx -y pnpm@11.7.0 --filter @quran-ai/web typecheck
npx -y pnpm@11.7.0 --filter @quran-ai/web test
npx -y pnpm@11.7.0 --filter @quran-ai/web build
```

Requires Node 22 (see repo root notes). Service URLs are overridable via
`VITE_PLATFORM_API_URL`, `VITE_ML_INFERENCE_URL`, `VITE_ASR_INFERENCE_URL`,
`VITE_REALTIME_GATEWAY_URL`.

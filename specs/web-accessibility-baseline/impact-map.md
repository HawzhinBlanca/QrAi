# Web Accessibility Baseline Impact Map

## Changed Symbols

- `AuthenticatedApp` in `apps/web/src/App.tsx`
  - Adds a skip-to-content link and `id="main-content"` on the workspace landmark.
  - Callers: `AppInner` renders this component in both `LOGIN_ENABLED=false` bypass mode and authenticated mode.

- `LoginScreen` in `apps/web/src/components/LoginScreen.tsx`
  - Adds accessible names for text, password, email, role, and language controls.
  - Marks login/register errors with `role="alert"`.
  - Callers: lazy import in `App.tsx`.

- `Sidebar` in `apps/web/src/components/Sidebar.tsx`
  - Adds `aria-current="page"` to the active navigation button.
  - Callers: `AuthenticatedApp` renders this component.

- Global CSS in `apps/web/src/styles.css`
  - Adds skip-link visibility, global focus-visible fallback, larger consent checkbox target, and reduced-motion styles.
  - Existing custom focus states remain for the surah picker, assistant input, and login fields.

## Test Coverage

- `pnpm --filter @quran-ai/web test`
- `pnpm --filter @quran-ai/web build`
- `bash scripts/verify.sh`

# Web Accessibility Baseline Research

## Target Surface

- `apps/web/src/App.tsx`
  - `AuthenticatedApp` owns the main shell, sidebar, and workspace landmark.
  - References: `AppInner` renders `AuthenticatedApp` for both login-disabled and login-enabled paths.
- `apps/web/src/components/LoginScreen.tsx`
  - `LoginScreen` owns the login/register form controls and inline error text.
  - References: lazy-loaded from `App.tsx`.
- `apps/web/src/components/Sidebar.tsx`
  - `Sidebar` owns the primary navigation buttons.
  - References: imported by `App.tsx`, rendered from `AuthenticatedApp`.
- `apps/web/src/styles.css`
  - Shared focus, visually-hidden, consent checkbox, and reduced-motion styles.

## Findings

- The application shell did not expose a keyboard skip link to the main workspace.
- Login/register form controls relied on placeholders or visual grouping instead of stable accessible names.
- Login errors were visually rendered but were not marked as alert content for assistive technology.
- Sidebar navigation already had visual active state but did not expose active-page state to assistive technology.
- Consent checkboxes were below the recommended comfortable touch target size.
- CSS transitions and animations did not have a global reduced-motion fallback.

## Acceptance Criteria

- WHEN a keyboard user tabs into the app shell, THE web app SHALL expose a skip link that targets the main content landmark.
- WHEN a screen reader reaches login/register controls, THE web app SHALL provide stable names for each input and select.
- WHEN login or registration fails, THE web app SHALL expose the error as alert content.
- WHEN a sidebar section is active, THE web app SHALL expose that state on the active navigation control.
- WHEN a user has reduced motion enabled, THE web app SHALL minimize CSS animation and transition duration.

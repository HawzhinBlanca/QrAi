/**
 * Whether this build may offer a language the project has NOT reviewed.
 *
 * ── The defect this exists to fix ───────────────────────────────────────────────────────────────
 * Three components each decided this for themselves, with the same expression:
 *
 *     import.meta.env.MODE === "test" ||
 *     new URLSearchParams(window.location.search).has("smoke")
 *
 * The second half is a RUNTIME check on a query parameter, so it survives into the production
 * bundle — confirmed by grepping `has("smoke")` out of the built `PlatformCommand` and `LoginScreen`
 * chunks. Anyone could append `?smoke` to a deployed URL and turn a one-option language picker into
 * a nine-option one.
 *
 * `data/platform.ts` declares exactly ONE locale `available`: English, the source language. The
 * other eight are `unavailable / not-shipped`, each carrying an evidence string that says so in as
 * many words — "No reviewed Urdu interface bundle is shipped."
 *
 * Selecting one is not cosmetic. `App.tsx` sets `document.documentElement.lang` to the chosen code
 * and flips `dir` to that locale's declared direction, while every string still resolves to English
 * through `fallbackLng`. The page then announces itself as Urdu to a screen reader — which reads
 * English text under Urdu pronunciation rules — and mirrors the entire chrome around it.
 *
 * It also contradicts a promise already written down. `resolveSelectableInterfaceLanguage` says:
 * "Never let a query string, persisted setting, or stale client select an unreviewed interface."
 * The picker could.
 *
 * ── An ALLOWLIST of build modes, and nothing at all from the request ───────────────────────────
 * The two modes that may offer an unreviewed language are named here. Anything else — `production`,
 * or a `--mode staging` build nobody thought about — gets the reviewed list, so the unknown case
 * fails CLOSED. Same reasoning as `canShowLearnerFacingAiOutput`'s status allowlist and
 * `check-licenses.mjs`'s licence allowlist: a denylist fails open on whatever it has not heard of.
 *
 * All three browser smokes (`smoke-browser`, `smoke-a11y`, `smoke-e2e`) start the Vite dev server,
 * so each runs with `MODE === "development"` and keeps the full list it selects from.
 *
 * `import.meta.env.DEV` is deliberately NOT consulted, though App.tsx's neighbouring
 * `canSpoofIdentity` uses it. Two reasons. It is derived from how Vite was invoked rather than from
 * what the build is, and it is true under vitest — so a test describing a production build would
 * have to stub both, and stubbing `DEV: false` ALSO flips App.tsx into its "you arrived without an
 * invite" state, where there is no picker left to assert anything about. Measured: doing that turned
 * the existing production-locale test from one option to zero. Keying on MODE alone is what lets a
 * component test describe a production picker at all.
 *
 * Taking `env` as an argument rather than reading `import.meta.env` directly is what makes the
 * production case testable in the first place: a test runs with `MODE === "test"`, so a predicate
 * reading the ambient environment could only ever be exercised in the mode that returns true.
 */
const MODES_THAT_MAY_OFFER_UNREVIEWED = new Set(["test", "development"]);

export function offersUnreviewedLanguages(env: { MODE: string }): boolean {
  return MODES_THAT_MAY_OFFER_UNREVIEWED.has(env.MODE);
}

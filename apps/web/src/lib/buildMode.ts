/**
 * Whether this build may show the user something that is not real.
 *
 * Two things turn on the same question, and both got it wrong the same way.
 *
 * ── 1. Languages the project has not reviewed ───────────────────────────────────────────────────
 * Three components picked their language list with:
 *
 *     import.meta.env.MODE === "test" ||
 *     new URLSearchParams(window.location.search).has("smoke")
 *
 * `data/platform.ts` declares exactly ONE locale available — English, the source language. The other
 * eight are `unavailable / not-shipped`, each with an evidence string saying so. Selecting one sets
 * `document.documentElement.lang` and flips `dir` while every string still resolves to English
 * through `fallbackLng`, so the page announces itself as Urdu to a screen reader reading English.
 *
 * ── 2. API answers that were never computed ─────────────────────────────────────────────────────
 * Six call sites in `lib/api.ts` and `lib/serverAsr.ts` used the SAME expression to return canned
 * data instead of calling anything:
 *
 *   startServerAsr        a transcript at confidence 0.95, nothing recorded, nothing transcribed
 *   predictAlignment      two words — بِسْمِ `matched` 0.95, اللَّهِ `misread` 0.85
 *   predictTajweed        one Ghunnah finding
 *   fetchSurahList        one surah
 *   fetchSurah            Al-Fatihah truncated to two ayahs
 *   requestTeacherReview  a localStorage write, then success
 *
 * `persistSessionAlignments` has NO such branch — it always POSTs. So the fabricated alignments from
 * `predictAlignment` were handed straight to it (App.tsx, "Persist the real alignment to this
 * session") and written to the real database against a real learner's real session. That is
 * fabricated evidence about a child's recitation entering the corpus from a QUERY STRING.
 *
 * It is the same defect `ML_USE_GOLDEN_FIXTURES` was hardened against on the server, and worse: that
 * one needs two environment variables and a boot-time acknowledgement, and the rows it writes are
 * now marked `analysis_basis = 'fixture'` (migration 0028). This needed a URL, and what it wrote was
 * indistinguishable from real.
 *
 * `requestTeacherReview` returning success after a localStorage write also reintroduced, behind
 * `?smoke`, the exact defect its own comment records as fixed: "the previous implementation flipped
 * a local UI step and displayed 'Sent to teacher.' without any request at all (SHIP_PLAN P1.2)".
 *
 * ── The fix ─────────────────────────────────────────────────────────────────────────────────────
 * `allowsFabricatedData` takes only the build mode — no request, no location, no search string — so
 * a URL cannot reach it. `usesSmokeStubs` below is the API layer's gate: it still honours `?smoke`,
 * because that is how a browser smoke asks for a stub, but only in a mode this function permits.
 * Either way, a production build has no answer a query string can change.
 *
 * An ALLOWLIST of modes, so `production` and any `--mode staging` build nobody thought about here
 * get the real thing. The unknown case fails CLOSED, the same reasoning as
 * `canShowLearnerFacingAiOutput`'s status allowlist and `check-licenses.mjs`'s licence allowlist.
 *
 * All three browser smokes (`smoke-browser`, `smoke-a11y`, `smoke-e2e`) start the Vite dev server,
 * so each runs with `MODE === "development"` and keeps every stub it depends on.
 *
 * `import.meta.env.DEV` is deliberately NOT consulted, though App.tsx's neighbouring
 * `canSpoofIdentity` uses it. It is true under vitest, so a test describing a production build would
 * have to stub both — and stubbing `DEV: false` ALSO flips App.tsx into its "you arrived without an
 * invite" state, where there is no picker and no practice flow left to assert about. Measured: doing
 * that turned the existing production-locale test from one option to zero. Keying on MODE alone is
 * what lets a component test describe a production build at all.
 *
 * Taking `env` as an argument rather than reading `import.meta.env` directly is what makes the
 * production case testable in the first place: a test runs with `MODE === "test"`, so a predicate
 * reading the ambient environment could only ever be exercised in the mode that returns true.
 */
const MODES_THAT_MAY_FABRICATE = new Set(["test", "development"]);

export function allowsFabricatedData(env: { MODE: string }): boolean {
  return MODES_THAT_MAY_FABRICATE.has(env.MODE);
}

/**
 * Whether THIS request should be answered from a stub instead of the service.
 *
 * The API-layer call sites are not the same shape as the language pickers, and conflating them was
 * a mistake worth recording. The pickers read `MODE === "test" || ?smoke` — a mode OR a flag. The
 * six API stubs read the flag ALONE, so they were inert in an ordinary test or dev run and fired
 * only for a browser smoke that asked for them by URL.
 *
 * Replacing the flag with the mode predicate therefore did not narrow those call sites, it WIDENED
 * them: every vitest run and every dev-server page load began answering from stubs. Measured — two
 * App smoke tests that rely on the app falling back to its default surah when the API is
 * unreachable started reading "Surah الفاتحة" from the canned list instead.
 *
 * So the flag stays, and the build mode gates it. `?smoke` still selects a stub exactly where it
 * always did, and in a production build there is no mode in which it can.
 */
export function usesSmokeStubs(env: { MODE: string }, search: string): boolean {
  return allowsFabricatedData(env) && new URLSearchParams(search).has("smoke");
}

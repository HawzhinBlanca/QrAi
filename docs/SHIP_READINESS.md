# QrAi — Ship-Readiness Runbook

The single source of truth for what stands between the current build and a **10/10 production
launch**. Each item is either **done (in code, CI-verified)**, **turnkey (config/steps ready — a
human runs them)**, or **needs a human/external decision that no code can supply**.

> Ground rule for a Qur'an learning platform: **correctness of Islamic content outranks everything.**
> Do not launch learner-facing tajweed instruction without a qualified scholar's sign-off (§A), no
> matter how green CI is.

---

## Status legend
- ✅ **Done** — implemented and CI-verified.
- 🧰 **Turnkey** — the engineering is ready; a human must execute the last step (provision a cert,
  set a secret, sign off). Steps are given below.
- 🚫 **Human-gated** — requires a scholar, lawyer, or a decision that is not the code's to make.

---

> **Important — read before trusting any ✅ below.** The items tagged **(PR #28)** — the
> mushaddad-ghunnah rule (A2), `golden-regression.test.mjs` (C7), the CSP/`nginx-unprivileged`
> work (D12), `scripts/load-test.js` (E14), and the docker-build non-root/trivy assertions (E15) —
> are implemented and CI-green **on branch `verify/ship-hardening-batch` (PR #28)**, which has
> been open, unmerged, and blocked purely on the owner's manual smoke test for the entirety of a
> long prior work session. They are **NOT part of `main`** as of this writing. Verified directly:
> `git diff main...origin/verify/ship-hardening-batch` shows `golden-regression.test.mjs` and the
> mushaddad-ghunnah addition to `tajweed.js` exist only on that branch; `main`'s own
> `services/ml-inference/tajweed.js` has no mushaddad-ghunnah rule at all. Anyone deploying
> `main` right now does not get these — only merging PR #28 does. Update this note once #28 merges.

---

## A. Qur'an correctness — the gate that outranks all others

| Rule (engine: `services/ml-inference/tajweed.js`) | What it detects | Confidence | Known simplification a scholar must judge |
|---|---|---|---|
| madd-tabii (مد طبيعي) | `َا` / `ُو` / `ِي` present | 0.88 | Does **not** distinguish madd types — muttasil/munfasil/lazim (4–6 counts) are all reported as "tabii" (2 counts). |
| madd-maleki (مد ملكي) | dagger alef `U+0670` | 0.85 | Fires on presence of the dagger alef only. |
| ghunnah (غنة) | `نْ`, word-final `ن`, or tanween `ًٌٍ` | 0.90 | Word-final noon treated as sakin (waqf); does not model wasl vowelling. |
| mushaddad-ghunnah (غنة) — **(PR #28, not yet on `main` — see the note above)** | noon/meem + shaddah `U+0651` (order-tolerant) | 0.92 | Proven 7215/7215 across all 114 surahs on PR #28's `golden-regression.test.mjs`; `main` does not have this rule at all. Non-controversial rule once merged. |
| qalqalah (قلقلة) | ق ط ب ج د + explicit sukoon | 0.87 | Only explicit `U+0652`; word-final qalqalah at waqf not caught unless marked. |
| tafkhim (تفخيم) | contains خ ص ض ط ظ ق | 0.84 | Fires on **presence**, not pronunciation context; ر/ل conditional tafkhim not modelled. |
| shaddah (شدة) | `U+0651` present | 0.86 | Reports doubling; correct. |
| idgham / iqlab / ikhfa | noon-sakin/tanween at word boundary + next letter class | 0.80–0.83 | Standard Hafs letter sets; inter-word only (validated whole-Qur'an in earlier PRs). |

**A1 — Scholar sign-off on the engine · 🚫 human-gated (packet ready → [`docs/SCHOLAR_REVIEW.md`](SCHOLAR_REVIEW.md)).**
The turnkey review packet is written: it lists every rule, its exact detection site, each known
simplification, and the specific questions to answer. Hand it (with `tajweed.js`) to a qualified scholar.
Ask them to confirm, per rule:
(1) the detection produces **no incorrect ruling**, and (2) the **scope is acceptable for a learning
aid** (it is a subset — it does not teach madd lengths, makharij, or full ra/lam rules). Record the
outcome (approve / disable-rule / fix) in `docs/DECISIONS.md`. **Until this exists, learner-facing
tajweed must stay labeled "AI suggestion — not yet reviewed"** (already enforced by
`canShowLearnerFacingAiOutput`).

**A3 — Scholar-validate the neural model (`tajweed-neural`) · 🚫 human-gated.** It is experimental,
off by default, and human-review-gated. Keep it off the learner path until a scholar validates its
sifat output on pilot data.

---

## B. Verify what's built

- **B4 — Container build + smoke · ✅/🧰 on `main` for 4 of 5 images; the 5th lands with PR #28.**
  `docker-build` CI (`main`'s current `.github/workflows/docker-build.yml`) builds all 5 images and
  asserts non-root (`appuser`, uid 10001) for `platform-api`, `realtime-gateway`, `ml-inference`, and
  `asr-inference`. The web image still builds `FROM nginx:alpine` (root) on `main` with no non-root
  assertion for it; PR #28 switches it to `nginxinc/nginx-unprivileged` and adds the matching CI
  check (see the note at the top of this doc). **Remaining human step:** run the full stack once —
  `ML_API_KEY=… ASR_API_KEY=… JWT_SECRET=… REALTIME_GATEWAY_TICKET_SECRET=… POSTGRES_PASSWORD=…
  docker compose up --wait` — and click through one recitation in a browser to confirm the CSP +
  relative-API path works end-to-end (no browser test exists in CI).
- **B5 — Mobile end-to-end · 🧰.** The app code is fixed (password auth, consent gate, proxy routing)
  and syntax-clean, but has **never run on a device**. Human step: `cd apps/mobile && npm i && npx
  expo start`, sign in, record, confirm the analysis round-trips.

---

## C. Measured quality
- **C7 — Golden-recitation regression · ✅ on PR #28, not yet on `main`** (`golden-regression.test.mjs`,
  wired into `scripts/verify.sh` on that branch): computes F1/coverage **live** on the real canonical
  data, not asserted constants. See the note at the top of this doc — `main` does not have this file.
- **C6 — Labeled eval dataset → live F1 · 🚫 needs methodology.** Deciding *what counts as a gold
  label* (which teacher, which rubric, held-out vs. train) is a research decision. Once defined, the
  harness in C7 extends to it directly.

---

## D. Production infrastructure — all 🧰 (turnkey) unless noted

- **D8 — TLS/HTTPS + HSTS · 🧰.** Terminate TLS in front of `platform-api`, `realtime-gateway`, and
  the web (a load balancer or an nginx TLS front). Then add `Strict-Transport-Security` at that edge.
  The app already serves over the compose network; only the public edge needs certs (Let's Encrypt).
- **D9 — Secrets · 🧰 (one command → `scripts/gen-production-secrets.sh`).** The code **refuses
  weak/default secrets in prod** (`ensure_secure_config`). Run `bash scripts/gen-production-secrets.sh`
  to generate strong (48-char, non-default) values for `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`,
  `ML_API_KEY`, `ASR_API_KEY`, `POSTGRES_PASSWORD` into a gitignored `.env.production` (mode 600), with
  `ALLOW_INSECURE_DEFAULTS=0`. Load it at deploy (`docker compose --env-file .env.production up -d`) or
  import into your secrets manager. Do **not** commit it or set `ALLOW_INSECURE_DEFAULTS` in prod.
- **D10 — DB posture · 🧰.** Run `platform-api` as the **restricted `quran_ai_app` role** (see
  `infra/sql/rls-app-role.sql`; nosuperuser + nobypassrls, so RLS actually bites). Add automated
  Postgres backups (pg_dump or a managed snapshot schedule) + a tested restore. Migrations apply in
  order (see `.github/workflows/ci.yml`).
- **D11 — Turn real auth on · 🧰.** Set `VITE_REQUIRE_LOGIN=1` and leave `ALLOW_HEADER_AUTH` unset
  (Bearer-only). Verify the login flow against the restricted role.
- **D12 — CSP + nginx-unprivileged · ✅ on PR #28, not yet on `main`**: full CSP + `nginx-unprivileged`;
  the browser uses the same-origin `/v1/` proxy in prod so `connect-src 'self'` holds. See the note
  at the top of this doc.

---

## E. Ops / resilience / CI
- **E15 — CI builds images + non-root assert + trivy scan · ✅ on PR #28, not yet on `main`**
  (`docker-build.yml`; see the note at the top of this doc).
- **E14 — Load test · 🧰 (script lands with PR #28).** `scripts/load-test.js` (k6) exists on
  PR #28, not yet on `main`. Human step once merged: run it against a staging deploy and tune
  pool sizes / rate limits to hit the stated thresholds (p95 targets).
- **E13 — Observability · 🧰.** Services emit structured JSON logs and the gateway exposes metrics.
  Human step: ship logs to an aggregator, scrape metrics into dashboards, and alert on error-rate +
  `/health`. No app code blocks this.

---

## F. Product / compliance / UX
- **F19 — Resilience / error states · partially on `main`, fully ✅ on PR #28.** Graceful
  degradation when ML/ASR is down. `main` already uses `fetchWithTimeout` in some call sites
  (`apps/web/src/lib/api.ts`); PR #28 completes the rollout to `data/platform.ts`, `data/quran.ts`,
  `lib/auth.tsx`, `lib/liveRecitation.ts`, and `lib/serverAsr.ts`, which on `main` still use bare
  `fetch` (no timeout) in places. See the note at the top of this doc.
- **F17 — Accessibility · 🧰 (automated layer done; manual pass remains).** `pnpm smoke:a11y`
  runs a real axe-core audit (headless Chrome, `scripts/smoke-a11y.mjs`) against Learner Home,
  the practice flow, and Internal Command — 0 violations on `main` (a real color-contrast
  failure it found, `--muted` text at 4.42-4.44:1 against the app's lightest backgrounds, is
  already fixed). axe-core only catches what's mechanically detectable (contrast, missing
  labels/roles, landmark structure) — it cannot verify keyboard-only task completion, screen
  reader announcement quality, or the Arabic-RTL reading-order findings this item originally
  called for. **Remaining human step:** a manual keyboard-nav + screen-reader pass, and RTL
  layout review once `docs/DECISIONS.md`-tracked RTL rendering work lands (the UI does not yet
  flip to RTL for Arabic/Kurdish Sorani/Urdu at all — see the open RTL-readiness task).
- **F18 — i18n completeness · 🚫 needs real translation work, not an audit.** Checked: there is
  no i18n infrastructure at all (no `i18next`/`react-intl`, no string-extraction, no translation
  files). `activeLanguage`/`supportedLanguages` (`apps/web/src/data/platform.ts`) only pick which
  *native name* to display in the language dropdown itself (e.g. "کوردیی ناوەندی") and tag session
  metadata sent to the backend — every actual UI label, button, and heading stays in English
  regardless of the 9 listed languages. This item was previously scoped as "audit for coverage
  gaps," implying partial support; the real starting point is 0% coverage and no framework. Real
  translations for a religious-education product need native-speaker review (the same reasoning
  `docs/SCHOLAR_REVIEW.md` already applies to tajweed content), so this isn't something to
  attempt as a quick autonomous pass — it needs a human decision on which languages to prioritize
  for the pilot and who reviews the translations, then real implementation work.
- **F20 — Mobile tests · ✅.** `apps/mobile/lib/session.ts` extracts the auth-header / consent /
  ASR-parsing logic; `apps/mobile/lib/session.test.ts` (node:test) gates it via the new `mobile` CI
  workflow (8/8 green). Pure logic only — the RN UI / `expo-av` path still needs a device (see B5).
- **F16 — Legal / compliance · 🚫 needs a lawyer (input packet ready → [`docs/DATA_INVENTORY.md`](DATA_INVENTORY.md)).**
  Privacy policy, terms, **COPPA** review (under-13 + guardian consent — the consent gate exists; the
  *policy* is legal), a data-retention policy, and a DPA for the pilot tenant. The data/PII inventory
  the lawyer needs (what is collected, where it lives, retention, erasure path, the guardian-consent
  gate, third parties) is written and code-cited; the lawyer authors the documents from it.

---

## The irreducible human checklist (nothing here is a code problem)
1. **Scholar signs off** on the tajweed engine (A1) and neural model (A3).
2. **Provision** TLS certs (D8) and strong secrets (D9); enable real auth (D11).
3. **Legal** publishes privacy/terms/COPPA/DPA (F16).
4. **Run** the container + mobile end-to-end smoke once (B4/B5) and the load test (E14).
5. **Wire** log aggregation + alerting (E13) and DB backups (D10).
6. **Merge PR #28** (`verify/ship-hardening-batch`) — it has been open, CI-green, and blocked
   purely on the manual container smoke test in item 4 above since before this checklist was
   last true for `main`. Until it merges, A2/C7/D12/E14/E15 and the web half of B4/F19 above are
   real and CI-verified *only on that branch*, not in what `main` would actually ship today.

Everything else is done in code and CI-verified — **on `main`, for the items not called out
above as PR #28-only.** **QrAi is engineering-ship-ready; it is not launch-ready until the five
items above (plus merging #28) are executed by a human.**

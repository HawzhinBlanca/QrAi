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

> **Update.** PR #28 (`verify/ship-hardening-batch`) was closed unmerged — its base had diverged
> too far from `main` to merge safely. Its content was triaged and re-implemented fresh against
> current `main` instead: `golden-regression.test.mjs` (C7, PR #130), the CSP/`nginx-unprivileged`
> work plus the resilience/relative-URL fixes it required (D12/F19, PR #129), and `scripts/
> load-test.js` (E14, PR #131) are now **on `main`**. Two pieces are deliberately still not on
> `main`: the mushaddad-ghunnah rule (A2 — the codebase's own test comment flags it "for scholar
> review," respected rather than shipped unilaterally; see A1) and the web image's non-root CI
> assertion + trivy scan (E15 — blocked on an edit to the CI-protected `docker-build.yml`).

---

## A. Qur'an correctness — the gate that outranks all others

| Rule (engine: `services/ml-inference/tajweed.js`) | What it detects | Confidence | Known simplification a scholar must judge |
|---|---|---|---|
| madd-tabii (مد طبيعي) | `َا` / `ُو` / `ِي` present | 0.88 | Does **not** distinguish madd types — muttasil/munfasil/lazim (4–6 counts) are all reported as "tabii" (2 counts). |
| madd-maleki (مد ملكي) | dagger alef `U+0670` | 0.85 | Fires on presence of the dagger alef only. |
| ghunnah (غنة) | `نْ`, word-final `ن`, or tanween `ًٌٍ` | 0.90 | Word-final noon treated as sakin (waqf); does not model wasl vowelling. |
| mushaddad-ghunnah (غنة) — **not yet implemented, flagged for scholar review** | noon/meem + shaddah `U+0651` (order-tolerant) | 0.92 | A working implementation exists (proven 7215/7215 across all 114 surahs via `golden-regression.test.mjs`) but is intentionally withheld pending A1's sign-off — `main`'s `tajweed.js` has no mushaddad-ghunnah rule at all yet. |
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

- **B4 — Container build + smoke · ✅ builds non-root for all 5 images; CI assertion still only
  covers 4 of 5.** `docker-build` CI (`.github/workflows/docker-build.yml`) builds all 5 images and
  asserts non-root (`appuser`, uid 10001) for `platform-api`, `realtime-gateway`, `ml-inference`, and
  `asr-inference`. The web image now builds `FROM nginxinc/nginx-unprivileged:alpine` (uid 101, not
  root) on `main`, but CI does not yet assert that uid for it — adding that check requires editing
  the CI-protected `docker-build.yml`, tracked as an open follow-up. **Remaining human step:** run
  the full stack once — `ML_API_KEY=… ASR_API_KEY=… JWT_SECRET=… REALTIME_GATEWAY_TICKET_SECRET=…
  POSTGRES_PASSWORD=… docker compose up --wait` — and click through one recitation in a browser to
  confirm the CSP + relative-API path works end-to-end (no browser test exists in CI).
- **B5 — Mobile end-to-end · 🧰.** The app code is fixed (password auth, consent gate, proxy routing)
  and syntax-clean, but has **never run on a device**. Human step: `cd apps/mobile && npm i && npx
  expo start`, sign in, record, confirm the analysis round-trips.

---

## C. Measured quality
- **C7 — Golden-recitation regression · ✅ on `main`** (`golden-regression.test.mjs`): computes
  F1/coverage **live** on the real canonical data, not asserted constants. Wired into `scripts/
  proof.sh` (the local pre-flight helper); not yet into `scripts/verify.sh` (what CI actually
  runs) since that file is CI-protected — an open follow-up.
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
- **D12 — CSP + nginx-unprivileged · ✅ on `main`**: full CSP + `nginx-unprivileged`; the browser
  uses the same-origin `/v1/` proxy in prod so `connect-src 'self'` holds.

---

## E. Ops / resilience / CI
- **E15 — CI builds images + non-root assert + trivy scan · 🧰 partial.** `docker-build.yml` builds
  all 5 images and asserts non-root for the 4 backend services (uid 10001). Two additions are
  still open, both requiring an edit to this CI-protected file: a matching non-root assertion for
  the web image (now uid 101, not 10001, since it's a different base image), and a report-only
  Trivy HIGH/CRITICAL CVE scan uploading results as CI artifacts.
- **E14 — Load test · ✅/🧰.** `scripts/load-test.js` (k6) is on `main`, covering platform-api's
  health/surah-list and ml-inference's health/alignment/tajweed endpoints — verified end-to-end
  against a real local stack. Note: the script's own `handleSummary` JSON output had a bug
  (fixed in a later PR) where `thresholds_passed` always reported `true` regardless of real
  pass/fail — every `check()` runs inside a `group()`, so it was reading an always-empty
  top-level checks array. `k6 run`'s own exit code (what actually gates a CI/terminal run) was
  never affected, only the JSON summary field; if a prior verification pass eyeballed that field
  instead of the exit code or the raw latency/error numbers, re-run the script to confirm.
  Human step: run it against a staging deploy and tune pool sizes /
  rate limits to hit the stated thresholds (p95 targets); note ml-inference's hardcoded 100 req/min
  per-IP rate limit will need raising (or the test's own concurrency lowering) for a meaningful
  sustained run — see the comment at the top of the script.
- **E13 — Observability · 🧰.** Services emit structured JSON logs and the gateway exposes metrics.
  Human step: ship logs to an aggregator, scrape metrics into dashboards, and alert on error-rate +
  `/health`. No app code blocks this.

---

## F. Product / compliance / UX
- **F19 — Resilience / error states · ✅ on `main`.** Graceful degradation when ML/ASR is down.
  `fetchWithTimeout` (`apps/web/src/lib/http.ts`) is used by every fetch call across `lib/api.ts`,
  `data/platform.ts`, `data/quran.ts`, `lib/auth.tsx`, and `lib/serverAsr.ts` (the last with a
  longer 30s bound, since real transcription can legitimately take that long).
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
1. **Scholar signs off** on the tajweed engine (A1, including the withheld mushaddad-ghunnah rule)
   and the neural model (A3).
2. **Provision** TLS certs (D8) and strong secrets (D9); enable real auth (D11).
3. **Legal** publishes privacy/terms/COPPA/DPA (F16).
4. **Run** the container + mobile end-to-end smoke once (B4/B5) and the load test (E14).
5. **Wire** log aggregation + alerting (E13) and DB backups (D10).
6. **Make four small edits across three CI-protected files** that an agent cannot self-edit:
   `ci.yml`'s Postgres migration list (missing 0015-0018), `docker-build.yml`'s web non-root
   assertion and its Trivy scan step (E15, two separate additions), and `verify.sh`'s node-services
   test line to include `golden-regression.test.mjs` (C7). Each is a one-line-per-item addition;
   the content to add is already written and tested, just not wired into the protected gate files.
   See open PR #123 and the corresponding task chips for the exact diffs.

Everything else is done in code and CI-verified on `main`. **QrAi is engineering-ship-ready; it
is not launch-ready until the five items above (plus the four small protected-file edits in item 6)
are executed by a human.**

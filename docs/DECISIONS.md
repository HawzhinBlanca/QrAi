# Architecture Decision Records

Short ADRs. Add one whenever you introduce a new runtime dependency or make an
architectural change. Newest first.

---

## ADR-0012 — i18next/react-i18next for web i18n; content ships English-only
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** `apps/web`'s language dropdown has listed 9 languages (Arabic, Kurdish Sorani —
the pilot's actual default, English, Turkish, Urdu, Indonesian, Malay, French, German) since
early in the project, but there was zero i18n infrastructure: no library, no string extraction,
no translation files. `activeLanguage` only picked which native name to display in the dropdown
and tagged session metadata sent to the backend — every actual UI string stayed hardcoded
English regardless of the selection (`docs/SHIP_READINESS.md` F18).

**Decision.** Added `i18next` + `react-i18next` (new runtime dependencies,
`apps/web/src/i18n/index.ts`) and extracted every hardcoded UI string across the app into
`apps/web/src/locales/en.json`. The other 8 languages are registered with empty resource
bundles and fall back to English (`fallbackLng: "en"`) rather than shipping AI-fabricated
translations. Real translations for a religious-education product need native-speaker/scholar
review before they ship — the same reasoning `docs/SCHOLAR_REVIEW.md` already applies to
tajweed content — so guessing at 8 languages' worth of UI copy would trade an honest, visible
gap for a dishonest, invisible one. This mirrors the "no fake data" principle already
established elsewhere in this codebase (e.g. `data/quran.ts`'s real vs. synthetic progress
data). Canonical Quran text, tajweed rule content, and real backend/dynamic data (agent run
names, teacher review notes, scholar approval topics) are explicitly excluded from translation
throughout, each with an inline comment.

**Consequences.** Switching the language dropdown today re-renders through real i18next
machinery and correctly falls back to English for the 8 untranslated languages — verified live
in the browser and via a regression test asserting `i18next.language` actually changes and
untranslated languages still render real English text, not raw translation keys. Before any of
the 8 languages can ship real content: (1) prioritize which languages the pilot actually needs
first (Kurdish Sorani is the immediate candidate, being the pilot's default), (2) establish a
native-speaker/scholar review process for the translated strings, (3) populate the
corresponding `apps/web/src/locales/<code>.json` files. None of that is a technical blocker —
the infrastructure and extraction are done — it's a product/review-process decision, tracked as
an open item until an owner scopes it.

---

## ADR-0011 — apps/mobile's npm audit findings are build-tooling-only, not shipped
**Date:** 2026-07-08 · **Status:** Accepted (tracked, not fixed)

**Context.** `apps/mobile` had never had `npm install` run this session (per `docs/
SHIP_READINESS.md` B5: the mobile app's UI/native path has never been run at all, even in the
most basic sense). Ran it for the first time to check for install-time issues. It installed
cleanly (656 packages) but `npm audit` reported 11 moderate-severity findings, all reducing to
two root advisories: `postcss <8.5.10` (XSS via unescaped `</style>` in CSS stringify output,
GHSA-qx2v-qp2m-jg93) and `uuid <11.1.1` (missing buffer bounds check, GHSA-w5hq-g745-h8pq).

**Reachability analysis.** Neither `postcss` nor `uuid` is a direct dependency of `apps/mobile`
(confirmed via `package.json`) or imported anywhere in the app's own source (`grep -rn "postcss\|
uuid" App.tsx lib/*.ts index.ts` — zero matches). Both are transitive dependencies of Expo's own
build/CLI tooling: `postcss` via `@expo/metro-config` (Metro bundler's CSS pipeline, a
build-time-only concern — this app's UI is React Native, not CSS), and `uuid` via `xcode` (an
`@expo/config-plugins` dependency that generates native Xcode project files during a native
build, never invoked by the running app). Neither package ships in, or is reachable through, the
compiled mobile app a learner would run.

**Decision.** Do NOT run `npm audit fix --force` in this pass. It would install `expo@57.0.4` — a
four-major-version jump from the currently pinned `~53.0.0` — for an app that has never been
run on a device or even started once, with no real-device testing capability available to verify
nothing broke. This is the same reasoning already applied in ADR-0009 to `services/tajweed-
neural`'s `transformers` CVE: a blind major-version bump on unreachable/build-tooling-only code
risks introducing real breakage to fix a vulnerability that was never exploitable in production.

**Consequences.** Tracked here as the source of truth for this decision, per the same convention
established in ADR-0009 and ADR-0008. Before `apps/mobile` is promoted out of "never run on a
device" status (`docs/SHIP_READINESS.md` B5), re-run `npm audit` against whatever Expo SDK
version is current at that time — Metro/CLI tooling versions move independently of the app's own
code, so this may already be resolved by then without any deliberate action here.

---

## ADR-0010 — Web image runs nginx-unprivileged with a full restrictive CSP
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** `apps/web`'s Docker image ran `FROM nginx:alpine`, which starts its master process as
root by default — the only one of the five service images not enforcing the non-root posture the
other four (`platform-api`, `realtime-gateway`, `ml-inference`, `asr-inference`) already have via
an explicit `useradd`/`USER appuser` (uid 10001). Separately, `nginx.conf`'s Content-Security-Policy
only set the directives that could never break the SPA regardless of deployment (`frame-ancestors`,
`base-uri`, `object-src`, `form-action`) — `default-src`/`script-src`/`style-src`/`connect-src` were
deliberately left unset, with a comment explaining they needed per-deployment testing against the
running app.

**Decision.** Switched the base image to `nginxinc/nginx-unprivileged:alpine`, which runs as UID 101
by default (a different UID than the backend services', since it's a different upstream image's
convention — no `useradd` needed). Unprivileged processes can't bind ports under 1024, so nginx now
listens on 8080 instead of 80, with `docker-compose.yml`'s port mapping and healthcheck updated to
match. Added the full CSP this deployment's real requirements support: `default-src 'none'` with
explicit per-directive allowlists, `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`),
`style-src 'self' 'unsafe-inline'` (React's dynamic inline styles — the mastery ring, accuracy ring,
and audio waveform bars all set `style={{ ... }}` directly), `connect-src 'self' ws: wss:` (the
nginx `/v1/` proxy plus the realtime gateway's WebSocket, which currently connects on a different
port than the page's own origin), and `media-src` including `cdn.islamic.network` (the real
reference-recitation audio source).

A strict `connect-src 'self'` only holds if the web app's own `fetch` calls are same-origin in
production. Every API-base-URL fallback across the client/data modules hardcoded an absolute
`http://127.0.0.1:8080`, which would bypass the nginx proxy and violate `connect-src 'self'`
outside dev — fixed by branching on Vite's build-time dev flag (absolute in dev, relative in the
production build). While touching those call sites, also switched every remaining raw `fetch()`
among them to the existing timeout-wrapped helper (`lib/http.ts`), so a hung backend can no longer
leave a login/register/progress call unresolved indefinitely.

Also discovered and fixed while verifying this: `nginx-unprivileged:alpine` has no `curl` (only the
four backend images install it for their healthchecks), so the compose healthcheck's `curl -f`
would have failed every 10 seconds forever once bound to the new base image — switched to a
`wget`-based check, available in Alpine by default. The same curl-availability gap was found and
fixed independently in `services/ml-inference/Dockerfile` around the same time.

**Consequences.** All five service images now run non-root. CI's `docker-build.yml` still only
asserts the non-root UID for the four backend services (uid 10001) — a matching assertion for the
web image's uid 101 has not been added, since that requires editing a CI-protected workflow file;
tracked as an open follow-up. The CSP is a hard boundary going forward: any new third-party script,
font, image, or media source added to the web app must be added to the corresponding directive in
`apps/web/nginx.conf`, or the browser will silently block it in production while dev keeps working
uninterrupted (CSP is only enforced by nginx, not the Vite dev server).

---

## ADR-0001 — Adopt the CODYSTEM harness as the governance + gate layer
**Date:** 2026-06-30 · **Status:** Accepted

**Context.** quran-ai-platform is a polyglot monorepo (TS + Rust + Node/Python services)
with an existing strict script (`scripts/proof.sh`) but no version control, no enforced
agent operating rules, and no single "done" definition.

**Decision.** Adopt CODYSTEM: `AGENTS.md`/`CLAUDE.md` operating rules, the Research → Plan →
Implement skills, deterministic `.claude` hooks (PreToolUse guard, PostToolUse fast verify,
Stop full verify), and `scripts/verify.sh` as the canonical gate. `verify.sh` runs the
infra-free core always (Rust fmt/clippy + TS typecheck + TS/Rust tests + build) and gates
the Postgres-only platform-api integration tests behind a reachable DB (skipped, never faked).
CI runs the same script, so local == CI. The repo is now under git.

**Consequences.** "Done" = `verify.sh` green AND required CI green — never agent judgment.
`scripts/proof.sh` is retained as the equivalent strictest local gate (it additionally
requires Postgres for platform-api). Follow-up: wire branch protection once a remote exists,
and optionally add a Postgres service to CI to run the DB-gated tests.

---

## ADR-0002 — Login is DISABLED for general users until production (owner-gated)
**Date:** 2026-07-01 · **Status:** Accepted (STRICT — do not change without the product owner)

**Context.** During the pilot/preview the product owner requires that general users reach
the app with **NO login step** — no sign-in screen, no account creation, no query-param
workaround. Authentication must stay off until the owner explicitly says the app is going
to production.

**Decision.** The web app renders directly with a default learner and **no login screen**.
This is controlled by a single build-time switch in `apps/web/src/App.tsx`:

    const LOGIN_ENABLED = import.meta.env.VITE_REQUIRE_LOGIN === "1";

- Default (env unset) → `LOGIN_ENABLED = false` → app renders `<AuthenticatedApp bypassLogin />`
  with a default learner (`learner-1` / `hikmah-pilot-erbil`). No `LoginScreen`, no `?smoke`.
- To RE-ENABLE login for production: set `VITE_REQUIRE_LOGIN=1` at build time. **Only the
  product owner authorizes this** — agents/contributors must NOT flip it on their own.

The `LoginScreen`, `register()`, and `login()` code is retained and wired; it is simply not
reachable until the flag is on.

**Consequences.** No credentials are required to use the pilot. The platform-api still
supports real auth (JWT + `/v1/auth/*`) for when login is turned on. Because there is no
per-user identity in bypass mode, all pilot activity is attributed to the default learner.

---

## ADR-0003 — ML inference accessed only through platform-api proxy
**Date:** 2026-07-03 · **Status:** Accepted

**Context.** The web frontend was calling the ML inference service directly, exposing
`VITE_ML_API_KEY` in the browser bundle. Any user could extract this key and call the ML
service without authentication.

**Decision.** Add `/v1/ml/alignments:predict` and `/v1/ml/tajweed-findings:predict` proxy
routes to `platform-api`. The frontend calls these endpoints (authenticated via JWT). The
platform-api forwards requests to the ML service, attaching the `ML_API_KEY` server-side.
New runtime dependency: `reqwest` (HTTP client) in `platform-api`, with a shared
`reqwest::Client` on `AppState` for connection pooling.

**Consequences.** ML API key never reaches the browser. The ML service is no longer
exposed on the public network (only reachable from `platform-api` on the internal Docker
network). Adds ~1ms of proxy latency per ML call.

---

## ADR-0004 — Canonical checksum upgraded from FNV-1a 32-bit to SHA-256
**Date:** 2026-07-03 · **Status:** Accepted

**Context.** Canonical Quran data checksums used FNV-1a 32-bit (`fnv1a32:` prefix), which
has a 32-bit collision space (~77k records for 50% collision probability). While adequate
for the current dataset, this is insufficient for long-term integrity guarantees.

**Decision.** New checksums use SHA-256 (`sha256:` prefix). The `verifyCanonicalWord` and
`verifyCanonicalAyah` functions accept both formats: they first check against SHA-256, then
fall back to FNV-1a for backward compatibility with existing seed data (which is immutable
per AGENTS.md). Implementation uses a pure-JS SHA-256 (FIPS 180-4) — no Node.js-only
dependencies — so it works in both the Node test environment and the browser bundle.

**Consequences.** Existing `fnv1a32:` checksums in seed SQL remain valid. New imports
produce `sha256:` checksums. A backward-compatibility test locks this contract. The pure-JS
implementation adds ~0.1ms per checksum vs. the native `node:crypto` path, which is
acceptable for the import/verification use case (not on a hot path).

---

## ADR-0005 — Full-Quran seed script now shares the real checksum builder; re-seed required for any already-seeded database
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `packages/quran-data/scripts/seed-full-quran-to-db.sh` computed each row's
`source_checksum` inline as `fnv1a32(rawText)` — a hash of the Arabic text alone. Both
`verifyCanonicalWord`/`verifyCanonicalAyah` (the only functions in the codebase that
validate these checksums) reconstruct the checksum from `canonicalWordPayload`/
`canonicalAyahPayload` — a pipe-joined string of `id|quranRef.display|ayahId|wordIndex|
text|sourceId|edition|scriptType|importVersion` — and this is true of *both* the SHA-256
path and the legacy FNV-1a fallback added in ADR-0004 (`legacyFnv1aChecksum` also hashes
the full payload, not raw text). So every row the production seed script wrote for the
real 114-surah corpus — including the currently-deployed `hikmah-pilot-erbil` database, if
already seeded from this script — has a `source_checksum` that neither verification path
can validate. This was latent (nothing calls `verifyCanonicalWord`/`verifyCanonicalAyah`
against the live DB today), not an active bug, but a real integrity gap: if a periodic
integrity sweep or a future write-path check is ever added, every full-Quran row fails it.

**Decision.** Reuse the existing, tested checksum machinery instead of re-deriving it a
third time:
1. `packages/quran-data/src/index.ts` gains `buildFullQuranSurahBundle(surah, sourceId,
   importVersion)`, generalizing `buildCanonicalAyah`/`buildCanonicalWords`/
   `createAyahReference`/`createWordReference` (previously Fatihah-only, hardcoding the
   `"Al-Fatihah"` display label) with a `surahLabel` parameter that defaults to
   `"Al-Fatihah"` — so `buildFatihahImportBundle`'s existing checksums are byte-for-byte
   unchanged. It calls the same `createCanonicalChecksum`/`createCanonicalAyahChecksum`
   functions `verifyCanonicalWord`/`verifyCanonicalAyah` actually check against.
2. `toCanonicalSqlSeed` now emits `ON CONFLICT (id) DO UPDATE SET ... source_checksum =
   excluded.source_checksum` (previously no conflict handling at all) for both
   `canonical_ayahs` and `canonical_words` — re-running the seed against an
   already-seeded database corrects every row's checksum in place; no separate migration
   or one-off `UPDATE` script is needed.
3. `packages/quran-data/scripts/write-full-quran-sql-seed.mjs` (run via `jiti`, the
   existing pattern used by `seed:sql`/`seed:json`) generates the full 114-surah SQL from
   `buildFullQuranSurahBundle`, printed to stdout rather than committed (at ~12MB it is a
   regenerable build artifact, not a migration).
   `seed-full-quran-to-db.sh` now pipes this script's output into `psql` instead of its
   previous broken embedded `node -e` snippet.
4. `packages/quran-data/tests/full-quran-checksum-integrity.test.ts` proves
   `verifyCanonicalAyah`/`verifyCanonicalWord` accept every one of the real 6236 ayahs and
   all their words across all 114 surahs — not just the 7-ayah Fatihah fixture.
5. The dead, never-invoked `fnv1a32`/`sha256` helper functions in
   `packages/quran-data/scripts/fetch-full-quran.mjs` are removed (a third, unused
   duplicate of this same logic).

**Consequences.** Any database already seeded by the old
`seed-full-quran-to-db.sh` (this includes the `hikmah-pilot-erbil` pilot database, if it
was seeded from the full-Quran script rather than only the Fatihah migration) has
`canonical_ayahs`/`canonical_words` rows with checksums in the old, unvalidatable format.
**Re-running `seed-full-quran-to-db.sh` against that database self-heals it** (the new
`ON CONFLICT ... DO UPDATE` corrects `source_checksum` — and defensively `text_uthmani` —
in place; no downtime or manual migration required), but this must be run deliberately by
whoever operates that database, and coordinated with them before running it against a
live pilot. No production code path currently depends on these checksums validating (the
gap was latent), so there is no user-facing regression from delaying the re-seed — but it
should happen before any integrity-sweep or write-path checksum validation is added.

---

## ADR-0006 — realtime-gateway now initializes a tracing subscriber
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `services/realtime-gateway/src/main.rs` never called
`tracing_subscriber::fmt().init()` (or any subscriber init), and `tracing-subscriber` was not
even a listed dependency — only the `tracing` facade crate was. Every `tracing::info!`/`warn!`
call throughout `lib.rs` — including CSWSH origin-rejection warnings, ticket validation
failures, and rate-limit events, all security-relevant — was silently dropped with nowhere to
go. Found by manually running the gateway locally: a rejected WebSocket connection produced no
log output at all, even at `RUST_LOG=debug`. `services/platform-api/src/main.rs` already
initializes a subscriber correctly; the gateway had simply never had this wired up.

**Decision.** New runtime dependency: `tracing-subscriber = { version = "0.3.20", features =
["env-filter"] }` in `services/realtime-gateway/Cargo.toml` (same version/features
`platform-api` already uses). `main.rs` now calls `tracing_subscriber::fmt().with_env_filter(...)
.init()` before binding the listener, defaulting to
`"quran_ai_realtime_gateway=info,tower_http=info"` when `RUST_LOG` is unset — mirrors
`platform-api`'s exact pattern.

**Consequences.** The gateway now actually emits its existing `tracing::warn!`/`info!` calls to
stdout in production, matching `platform-api`'s observability. No behavior change to request
handling — this only makes already-written log statements visible. Verified: the same connection
that previously failed silently now logs `realtime ticket tenant 'X' does not match gateway
tenant 'Y'` (or the relevant CSWSH/ticket-validation reason) immediately.

---

## ADR-0007 — Automated accessibility audit via axe-core (F17)
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `docs/SHIP_READINESS.md` F17 called for "an axe/Lighthouse pass on the web app" with
no automation in place — the only prior attempt this session was a hand-rolled contrast/focus
checker in ad-hoc browser JS, which produced three false positives (missed `linear-gradient`
backgrounds, misused `getComputedStyle`'s pseudo-element parameter for a pseudo-class, and was
fooled by a stale scroll position) before a single real finding. Manual DOM probing is not a
reliable substitute for a real accessibility engine.

**Decision.** New dev dependency: `axe-core` on `@quran-ai/web`. `scripts/smoke-a11y.mjs` (new,
root-level, following `scripts/smoke-browser.mjs`'s existing headless-Chrome-via-DevTools-Protocol
pattern) injects axe-core's bundled source into a real running instance of Learner Home, the
practice flow, and Internal Command, and fails on any violation. Exposed as `pnpm smoke:a11y`,
alongside the existing `smoke:*` commands — not part of `scripts/verify.sh`, matching every other
smoke script's convention (they validate a deployed/running stack, not a code diff).

**Consequences.** This audit caught one real, previously-unknown WCAG AA failure on first run:
`--muted` (`#7b7466`) measured 4.42-4.44:1 against the app's lightest paper backgrounds, just under
the 4.5:1 required for normal-size text (`.platform-app small`, `.capture-state`/`.gateway-state`
status text). Darkened to `#777163` — a visually near-identical shade — which clears 4.5:1 with a
comfortable margin everywhere `--muted` is used, not just the two flagged elements. `pnpm
smoke:a11y` now passes with 0 violations across all three audited screens. axe-core only catches
mechanically-detectable issues (contrast, missing labels/roles/landmarks) — it cannot verify
keyboard-only task completion or screen-reader announcement quality, so F17's manual pass remains
open (see `docs/SHIP_READINESS.md`).

---

## ADR-0008 — Dependency vulnerability scanning via cargo-audit (best-effort)

**Date:** 2026-07-07 · **Status:** Proposed (implementation blocked — see Consequences)

**Context.** `scripts/verify.sh` has no dependency-vulnerability scanning for either Rust
service. Running `cargo audit` locally against `services/platform-api` surfaces
`RUSTSEC-2023-0071` (the `rsa` crate's Marvin Attack timing side-channel, no fixed version
available upstream) via `sqlx-macros-core`, which lists `sqlx-mysql` (which depends on `rsa`) as a
Cargo.lock dependency edge — even though `platform-api`'s enabled `sqlx` features are
`["runtime-tokio", "postgres", "uuid", "json", "chrono"]`, with no `"mysql"` feature requested
anywhere in the workspace. Verified with `cargo tree -e normal,build,dev -i rsa` (and the same for
`-i sqlx-mysql`) across all targets from `services/platform-api`: both print "nothing to print",
confirming `rsa` is not part of the actually-compiled dependency graph. `services/realtime-gateway`
(no `sqlx` dependency) audits clean with zero findings. This is `cargo-audit`'s documented
lockfile-vs-feature-graph limitation — it scans every package recorded in `Cargo.lock`, not what a
given feature selection actually compiles — not a real vulnerability reachable in the shipped
binary.

**Decision.** `scripts/verify.sh` should add a best-effort `cargo audit` step, matching the exact
pattern already used for the live-Postgres-gated integration tests: run it if `cargo-audit` is
installed, SKIP with an honest message (never a false "VERIFY OK") if it isn't. When run, it should
pass `--ignore RUSTSEC-2023-0071` for `platform-api` only (not `realtime-gateway`, which has no
occasion to need it), with a comment pointing back to this ADR for the justification above.
`.github/workflows/ci.yml` does not currently install `cargo-audit` (only
`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`), so this only protects local runs by
default until a maintainer separately decides whether the ~30s `cargo install cargo-audit --locked`
step is worth the added CI time on every run — that tradeoff belongs in `ci.yml`, not here.

**Consequences.** `scripts/verify.sh` is a CODYSTEM enforcement file requiring a human-audited
`.codystem-allow-self-edit` sentinel to modify — the agent that investigated this (confirmed the
`rsa` finding is a false positive, and worked out the exact ignore-flag fix above) could not apply
it. This ADR exists so the next session/human implementing the change doesn't have to re-derive the
investigation. Until implemented, neither Rust service has automated dependency-vulnerability
scanning in the gate.

---

## ADR-0009 — transformers CVE tracking (services/tajweed-neural) and a false "already tracked" claim

**Date:** 2026-07-07 · **Status:** Accepted (tracking); upgrade deferred

**Context.** `docker-compose.yml`'s `asr-inference` service comment claimed switching to the
specialized Quran ASR model has "real costs (transformers as a new prod dependency — see the
pinned CVEs already tracked for it in services/tajweed-neural's lockfile)". No such tracking
existed anywhere in the repo — `grep -rn "CVE-" .` (excluding `node_modules`/venvs) returned zero
matches before this ADR. The claim was false.

Actually running `pip-audit` against `services/tajweed-neural/requirements.lock.txt` (via its own
`.venv312`, since the pinned versions target Python 3.12) found the claim's *spirit* was right even
though the tracking wasn't real: `transformers==4.57.6` has three real advisories, two of them
critical RCE:

- **PYSEC-2025-217 / CVE-2025-14929** — RCE via the X-CLIP checkpoint-conversion script's unsafe
  deserialization. No fix version listed upstream.
- **CVE-2026-1839 / GHSA-69w3-r845-3855** — RCE via `Trainer._load_rng_state()` calling
  `torch.load()` without `weights_only=True`. Fixed in `transformers` 5.0.0rc3.
- **CVE-2026-4372 / GHSA-29pf-2h5f-8g72** (critical) — RCE via a malicious `config.json`'s
  `_attn_implementation_internal` field, causing `from_pretrained()` to download and execute
  arbitrary code from an attacker-controlled Hub repo. Bypasses `trust_remote_code`. Fixed in
  `transformers` 5.3.0.

**Reachability in this codebase, verified by reading the actual code (not assumed):**
`services/tajweed-neural` never imports or uses `Trainer` (`grep -rn "Trainer" *.py vendor/*.py`
— zero matches), so CVE-2026-1839 is not reachable here. The X-CLIP conversion script
(PYSEC-2025-217) is unrelated to this service's Wav2Vec2Bert model and is never invoked.
CVE-2026-4372's exploitation path is the live one: every `from_pretrained()` call in
`model_loader.py`/`vendor/multi_level_tokenizer.py` uses `model_id`, which resolves to
`MODEL_ID = os.environ.get("TAJWEED_NEURAL_MODEL", "obadx/muaalem-model-v3")` — a
server-configured deploy-time value, never attacker/request input. The realistic exposure is a
supply-chain one (the specific pinned Hub repo, `obadx/muaalem-model-v3`, being compromised
upstream), not a per-request vulnerability an external caller can trigger through this service's
own API surface. Combined with `services/tajweed-neural` already being documented as
**EXPERIMENTAL and off by default** (see its own `server.py` module docstring — the learner path
uses the reviewed rule-based tajweed engine, not this model), the risk is real but currently
narrow.

**Decision.** Track this honestly instead of the prior false claim. Fixed the `docker-compose.yml`
comment to point at this ADR. Do NOT bump `transformers` to `>=5.3.0` in this pass: it is a major
version jump against a vendored, third-party custom model class
(`Wav2Vec2BertForMultilevelCTC`/`MultiLevelTokenizer` under `vendor/`, from
github.com/obadx/prepare-quran-dataset) that this session cannot safety-test without the real
model weights and a from-scratch inference run — a blind major-version bump risks silently
breaking model loading rather than fixing anything, for a service that is not currently reachable
in production. Upgrading to `transformers>=5.3.0` (and re-vendoring/re-testing the custom model
class against the new API) should be a required precondition before `tajweed-neural` is ever
promoted out of "experimental, off by default."

**Consequences.** `services/tajweed-neural/requirements.lock.txt` still pins the vulnerable
version; this ADR is the source of truth for that decision until the service is promoted to
production, at which point the upgrade above is mandatory, not optional. `services/asr-inference`
does not import `transformers` at all in its current Dockerfile build (see the same
`docker-compose.yml` comment thread) so is unaffected regardless.

---

## ADR-0013 — hamza-on-carrier (ؤ/ئ) ASR variance: partial credit, not full normalization

**Date:** 2026-07-08 · **Status:** Accepted (interim); full normalization pending scholar review

**Context.** PR #56 unified taa marbuta (ة) with haa (ه) in `normalizeArabic()`, since the two are
acoustically similar in pause form with no tajweed significance — verified empirically that ASR
transcribing a correctly-recited taa-marbuta word as haa scored as low as 0.75 similarity, wrongly
landing in the "misread" band. While investigating that fix, a similar-looking gap surfaced: hamza
on a carrier letter (ؤ hamza-on-waw, ئ hamza-on-yaa) vs the bare carrier (و, ي) is not normalized
either, and produces comparably low scores — `similarity("مؤمن", "مومن")` = 0.75,
`similarity("سئل", "سيل")` = 0.667 (adjacent to `reviewThreshold`'s 0.65 missed/review boundary).

Unlike taa-marbuta/haa, hamza articulation is **itself a genuine tajweed correctness point**:
hamzat al-qat' is a real, always-pronounced glottal stop a Quran teacher corrects when dropped or
mispronounced (hamzat al-wasl is context-dependent — silent when connected in flowing recitation —
but that is a separate, already-context-free case from the bare-carrier substitution here). Web
research on Arabic ASR confirms hamza is a well-documented error source in Arabic transcription —
both misrecognition and spurious insertion — but found no equivalent to the taa-marbuta/haa
acoustic-equivalence claim: nothing establishes that an ASR writing a bare carrier for a
hamza-on-carrier grapheme reliably means the reciter articulated the hamza correctly. Fully
normalizing ؤ/ئ to و/ي, the same way as taa-marbuta/haa, therefore risks the more serious opposite
failure mode: scoring a genuinely dropped or mispronounced hamza as "matched" (a false positive),
in a product whose entire value proposition is accurate correction of recitation errors.

**Decision.** Do not fully normalize. Instead, `levenshtein()` in
`services/ml-inference/alignment.js` now gives a hamza-on-carrier/bare-carrier **substitution**
(ؤ↔و, ئ↔ي at the same string position) partial credit — cost 0.5 instead of a full 1 — via a new
`substitutionCost()` helper, leaving `normalizeArabic()` itself untouched. This is deliberately
narrower than full normalization:
- `similarity("مؤمن", "مومن")` moves from 0.75 → 0.875 (out of "misread", into "needs-review" —
  still surfaced for a teacher, not silently accepted as "matched").
- `similarity("سئل", "سيل")` moves from 0.667 → 0.833 (still "misread", but clear of the
  `reviewThreshold` boundary rather than sitting on it).
- Partial credit applies **only** to a same-position substitution. An outright dropped hamza (an
  insertion/deletion, e.g. `similarity("شيء", "شي")`, deleting the word-final hamza entirely) is
  unaffected — still a full-cost edit, still flagged — because that is a real, correctable
  recitation error, not an orthographic ASR ambiguity.

This mirrors the fallback option flagged when this gap was first raised: normalize only enough to
stop ASR noise from tipping a correct recitation into "misread"/"missed", while keeping the word
flagged for review rather than masking it as fully "matched" — pending an actual scholar ruling.

**Consequences.** No test needing a hamza-carrier pair to score a full 1.0 match should ever be
added without a scholar sign-off recorded as its own ADR (following the `docs/SCHOLAR_REVIEW.md`
sign-off pattern already used for the rule-based tajweed engine). If a qualified reviewer confirms
hamza-on-carrier ASR variance should be scored as fully equivalent — or, conversely, that even
partial credit is inappropriate and it must score as a full penalty — `substitutionCost()` in
`services/ml-inference/alignment.js` is the single place to change, with `alignment.test.mjs`
updated to match.

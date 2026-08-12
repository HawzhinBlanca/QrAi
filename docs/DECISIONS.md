# Architecture Decision Records

Short ADRs. Add one whenever you introduce a new runtime dependency or make an
architectural change. Newest first.

---

## ADR-0020 — Open learner self-registration is retained for the pilot (F2)
**Date:** 2026-07-24 · **Status:** Accepted (owner decision)

**Context.** The 2026-07-23 adversarial audit flagged F2: `POST /v1/auth/register` allows
unauthenticated self-registration for `role == learner` and returns a learner Bearer JWT for the
(hardcoded) pilot tenant, coexisting with the admin-minted invitation path (ADR-0019). It bypasses
"invitation-only" and permits account/spam creation (rate-limited only).

**Decision.** Keep open learner self-registration for the pilot. The owner accepts it as a valid
entry path alongside invitations.

**Why it is bounded (residual risk accepted).** The minted JWT is `learner`-scoped only; every
handler enforces `require_self_or_any` + RLS, so a self-registered account sees only its own (empty)
rows — no cross-tenant/cross-user access (audit: no IDOR). Elevated-role registration stays gated
(an authenticated Admin/Ops caller + tenant match, `user.rs`). Abuse is limited to spam account
creation, mitigated only by the Governor rate limiter.

**Consequences.** "Invitation-only" is a soft convention, not a hard gate, during the pilot. If spam
becomes a problem, gate `register` (learner role) behind an `ALLOW_OPEN_REGISTRATION` flag or require
an invitation — a small, localized change. Revisit before any wider launch.

---

## ADR-0019 — Pilot invitations: admin-minted, single-use, hash-stored; the web exchanges them for the `__Host-qrai-pilot` cookie
**Date:** 2026-07-23 · **Status:** Accepted

**Context.** ADR-0002 disables login for the pilot; the current default identity is a hardcoded
`learner-1` sent via spoofable `x-user-id`/`x-tenant-id` headers (gated by `ALLOW_HEADER_AUTH`). The
pilot-identity feature (`specs/pilot-identity-hardening`, #238) added a server-authoritative
`__Host-qrai-pilot` cookie plus `bootstrap`/`logout`, but `research.md` flagged that the
"invitation-issuance mechanism is not present anywhere" and the web never consumed the cookie — so
the boundary existed but was unused (P1.6 open).

**Decision.**
- **Issuance:** `POST /v1/pilot/invitations` (Admin/Ops, own tenant only) mints a single-use
  invitation for a learner. The raw token is returned exactly once; only its SHA-256 hash is stored.
  TTL defaults to 7 days (168h), clamped to [1h, 30d]. Non-learner or cross-tenant targets are rejected.
- **Redemption:** the learner opens `?invite=<token>`; the web calls `bootstrap` (credentials
  included) to receive the cookie, stores the returned identity + CSRF token in `lib/pilotSession`,
  and strips the token from the URL/history.
- **Requests:** in pilot mode the web sends the cookie (`credentials:"include"`) plus `x-csrf-token`
  on mutations, and STOPS sending `x-user-id`/`x-tenant-id`. Identity is server-derived from the
  cookie; request-body fields (e.g. `learnerId`) are non-authoritative.
- **Additive:** with no invite and no stored session the app keeps the existing default/dev-header
  path unchanged, so nothing breaks for local dev or the smoke suite.

**Consequences.**
- Learners get a real, revocable, per-user identity without a login screen (ADR-0002 preserved).
- To fully close the header-spoofing gap in production the deployment must set `ALLOW_HEADER_AUTH`
  off and distribute invite links; that flip, the live-browser walkthrough (P1.6 proof), and the
  security-reviewer sign-off (P1.7) are the remaining pilot-identity steps.
- `CORS_ALLOWED_ORIGINS` MUST be set to the exact web origin(s) in production. It gates both the
  pilot Origin allowlist and browser CORS; when empty both degrade to permissive. As of the F1
  hardening, `platform-api` **fails closed on boot** if it is empty while `ALLOW_INSECURE_DEFAULTS`
  is off (mirroring the realtime gateway and the JWT/ticket/ML/ASR secret checks), so a misconfig is
  loud rather than a silently decorative Origin check.
- Invitation *distribution* (email/SMS/hand-out) is out of scope: the endpoint returns the token and
  an optional `inviteUrl` (when `PILOT_INVITE_BASE_URL` is set); an operator delivers it.

---

## ADR-0018 — Release evidence is external, candidate-bound, and fail-closed
**Date:** 2026-07-19 · **Status:** Accepted for engineering implementation

**Context.** The original `scripts/release-manifest.mjs` writes its manifest
inside the source checkout and then accepts either `HEAD` or `HEAD~1` as the
candidate. That makes it possible for a stale manifest to appear valid after a
second commit. It also ignores untracked files and accepts missing container
image digests. The current manifest demonstrated all of these weaknesses: it
was bound to an older commit and contains null image digests.

**Decision.** Release evidence version 2 is generated as an external CI/release
artifact, never as a tracked or untracked file inside the candidate checkout.
Its verifier SHALL require the exact current candidate SHA, a completely clean
working tree including untracked files, non-empty digests for every deployable
service, and matching hashes for the declared candidate files. It SHALL also
bind a passing build summary, SPDX SBOM, aggregate smoke summary, test summary,
environment summary, expiry, and an Ed25519 signature to that exact candidate.
The signer is selected from a trusted-signer policy rather than an arbitrary
public-key command-line argument; the policy's hash and ID are themselves
signed into the evidence.

The trusted-signer policy is a release-control input, not candidate-owned
source. The protected CI/release environment must mount and pin it; supplying
an arbitrary policy while running the command locally does not create a trusted
release. Version-1 manifests are historical evidence and cannot certify a new
release. The evidence artifact is not, by itself, release authorization:
approval, protected CI wiring, independent challenge, and operational evidence
remain mandatory follow-up work in the readiness-recovery ledger.

**Consequences.** A release engineer or CI job must provide an external manifest
path, trusted-signer policy, and candidate-bound build/SBOM/smoke/test/
environment summaries when generating or verifying a candidate. Existing
`number-one-release` manifests will deliberately fail verification. A clean,
reproducible positive path can be proven without a self-referential evidence
commit, while any developer-local or incomplete evidence is rejected rather
than softened.

---

## ADR-0014 — Scholar review and approval of Tajweed rule scope
**Date:** 2026-07-15 · **Status:** Approved
**Reviewer:** Sheikh Hisham al-Erbili (mujawwid, Erbil Pilot Advisor)

**Context.** As required by Phase 1 Task 1.1, the rule-based Tajweed engine must be signed off by a qualified scholar before release. The scholar review packet (`docs/SCHOLAR_REVIEW.md`) lists the per-word and inter-word rules, simplifying constraints, and open questions.

**Decision.**
Sheikh Hisham al-Erbili reviewed the packet and approved the scope with the following responses to the six questions:
1. **A1 — detection correctness:** The sites where the Madd Tabii, Madd Maleki, Qalqalah, Tafkhim, Shaddah, Idgham, Iqlab, and Ikhfa rules fire are doctrinally correct for Hafs an Asim.
2. **A1 — acceptable simplifications:** Yes, the simplifications (e.g., Madd types not distinguished, Tafkhim on presence without rā' or Allah's lām, Idgham not split) are acceptable for a practice-assist tool under the condition that all outputs are teacher-reviewed and labeled provisional.
3. **A1-1 — mushaddad ghunnah:** Approved to be withheld from this release (per ADR-0013) to ensure no incorrect claims are made.
4. **A1-2 — ghayn in tafkhim:** Approved to omit `غ` for the current version; its omission is acceptable for practice assistance.
5. **A3 — labelling:** Yes, "AI suggestion · not yet reviewed" combined with teacher-gating is a sufficient and honest frame.
6. **Withhold list:** Only mushaddad ghunnah is withheld, which is already correctly handled by not generating it.

**Consequences.** The Tajweed engine's rule scope is officially signed off and cleared. No additional code changes are needed to modify the active rule list for this release.

---

## ADR-0013 — Explicit release gating of the mushaddad ghunnah Tajweed engine limitation
**Date:** 2026-07-15 · **Status:** Accepted (withheld, with explicit warning)

**Context.** The rule-based tajweed engine (`services/ml-inference/tajweed.js`) handles natural madd, dagger alif, coarse ghunnah, and qalqalah. However, it does not currently implement nūn/mīm mushaddad ghunnah (obligatory nasalisation on نّ/مّ, e.g. in `إِنَّ`, `ثُمَّ`), which is marked as a `TODO` in `services/ml-inference/tajweed.test.mjs`. In a religious-education and Quran-learning product, shipping an AI/rule-based engine that silently ignores this rule or conflates it with simple shaddah without scholar sign-off poses a doctrinal correctness risk.

**Decision.**
1. We explicitly **withhold** mushaddad ghunnah from the active rule-detection set for the current release. The engine will continue to flag simple consonant doubling (`shaddah`) without incorrectly claiming it has graded the obligatory ghunnah nasalisation.
2. We added a visible note in the scholar review guidelines (`docs/SCHOLAR_REVIEW.md` Question A1-1) to ensure the next iteration of the engine (which will implement the two-count mushaddad ghunnah detection) is reviewed and signed off by a qualified scholar before it is enabled.
3. For general transparency, the learner-facing interface labels all AI-generated tajweed suggestions as *"AI suggestion · not yet reviewed"* and gates them behind the contract's teacher review/approval gates (`contracts` check `canShowLearnerFacingAiOutput`), preventing any unverified feedback from reaching the student.

**Consequences.** At the time of this ADR, the scoped Tajweed behavior did not
present half-implemented or unverified feedback to the learner. This
component-level conclusion is not a current release-readiness claim; any new
candidate still requires the recovery ledger's full source, evaluation, and
scholar evidence. Implementing and signing off on the mushaddad ghunnah rule
remains a post-release enhancement requiring a qualified scholar's verification
packet sign-off.

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

## ADR-0015 — Word-level audio timings via Quran.com v4, deterministically mapped to canonical words

**Status:** Accepted · **Date:** 2026-07-15 · **Deciders:** owner (data provenance)

### Context
Real-time word-by-word follow-along (Tarteel's signature feature) needs per-word audio timings.
None existed in the repo; `persistSessionAlignments` shipped `startMs:0/endMs:0`. Inventing
millisecond timings is fabrication and forbidden. Real, matched timing data is available openly.

### Decision
Ingest word-level segment timings from **api.quran.com v4** (`verses/by_key/{key}?audio=7`,
Al-Afasy) as static, checksummed JSON in `packages/quran-data`. The audio master is Quran.com's own
(`verses.quran.com`), so timings and playback audio are matched by construction — no cross-master
drift. Playback for timed surahs moves from the islamic.network CDN to the Quran.com master.

Our canonical word segmentation does **not** match Quran.com's for two DETERMINISTIC reasons:
(1) our ayah 1 of a basmala surah prepends the 4 basmala words; (2) our text tokenizes standalone
waqf marks (e.g. ۛ) as separate words. The ingest normalizes both away and then **requires exact
count parity** before mapping segment→canonical word id; any ayah that still doesn't match, or that
carries a degenerate source segment (`end<=start`, observed at 2:164/2:249), is **excluded and
logged**, never truncated or guessed. Basmala/waqf tokens simply carry no timing.

### Options considered
- **A. Quran.com v4 API + strict alignment (chosen).** Open data, matched master, deterministic
  mapping, verified against canonical text. Coverage 340/344 pilot ayahs (99%).
- **B. Graft QUL timings onto the existing islamic.network audio.** Rejected: different masters →
  systematic drift; timings measured against one encode don't hold on another.
- **C. Adopt Quran.com word keys as our canonical segmentation.** The proper long-term fix (audit's
  data-layer recommendation) but a larger migration; deferred. This ADR maps onto our existing ids.

### Consequences
- Easier: follow-along highlight (T2), and any future per-word audio evidence.
- Harder / follow-ups: ayah-1 basmala words and standalone waqf marks are intentionally un-timed
  (won't highlight); the 4 excluded pilot ayahs need Quran.com word-key adoption (option C) to
  recover. Commercial launch must confirm the specific reciter resource's license on QUL
  (see docs/DATA_LICENSES.md#quran-com-word-segments-audio).

## ADR-0016 — Sorani (Kurdish) ayah translations via Quran.com/QuranEnc, rendered verbatim

**Status:** Accepted · **Date:** 2026-07-15 · **Deciders:** owner (content provenance)

### Context
The app's default language is Central Kurdish (Sorani, `ckb`) but it shipped ZERO translated verse
content — a Kurdistan learner read an English UI over Arabic they may not understand. This is the
core of the "#1 for Kurdish speakers" strategy (ROAD_TO_1 T4). Fabricating Quran translation is
forbidden; a licensed Sorani translation exists as open data.

### Decision
Ingest translation id 81 (**Burhan Muhammad-Amin / Tafsiri Asan**, the default Kurdish on
Quran.com, from the QuranEnc ecosystem) from api.quran.com v4 as static JSON in packages/quran-data,
and display it under each ayah in the reader (RTL, `lang="ckb"`), toggleable, default-on when the
app language is `ckb`. Text is stored and rendered **verbatim** — QuranEnc's license forbids any
modification. Ayahs the source has no entry for (e.g. 108:3, which Quran.com 404s) are recorded as
missing and render nothing — never invented.

### Options considered
- **A. Quran.com v4 id 81 (chosen).** Live, licensed, the region's default reading, 339/340 pilot
  ayahs. Attribution + verbatim storage satisfy the license.
- **B. QuranEnc bulk JSON dumps.** Same underlying text; heavier ingest, no per-ayah API. A valid
  alternate if the API is unavailable.
- **C. Machine translation.** Rejected outright — fabrication of religious content.

### Consequences
- Easier: Kurdish learners get meaning; sets the pattern for Arabic/other translations (add a slug).
- Follow-ups (docs/DATA_LICENSES.md#ckb-sorani-translation): confirm the QuranEnc **version string**
  and schedule periodic re-fetch (the license's continuing-update duty); Quran.com's API exposes no
  version field, so `fetchedAt` is only a drift anchor. Native-speaker review of the *UI strings*
  (ckb bundle) remains T5 — this ADR covers verse translations only.

## ADR-0017 — /v1/force-align is a real CTC forced aligner (T3), replacing Whisper-prompt bias

**Status:** Accepted · **Date:** 2026-07-16 · **Deciders:** owner (new model dependency)

### Context
`/v1/force-align` was dead code that used Whisper's `initial_prompt` to *bias* decoding — it did not
guarantee word-for-word correspondence with the canonical text, so it could not produce trustworthy
per-word timestamps (T3). The learner path still persisted `startMs:0/endMs:0`.

### Decision
Reimplement `/v1/force-align` as true CTC forced alignment: `torchaudio.functional.forced_align`
against an **Apache-2.0** Arabic model (`jonatasgrosman/wav2vec2-large-xlsr-53-arabic`, overridable
via `FORCE_ALIGN_MODEL`) on the diacritic-stripped canonical characters, so response word *i* IS
transcript word *i*. Logic lives in `services/asr-inference/forced_align.py`; the alignment model
loads lazily on first call (separate from the ASR model) so the service boots unchanged.

Validated: `forced_align_arabic.py` imports the exact shipped `align_words` and checks it against
Quran.com ground truth — mean word-START error ~64-100 ms over Al-Fatihah 1:1-1:3 -> PASS.

### Consequences
- New dependency: **`transformers`** (Apache-2.0), NOT yet in `requirements.lock.txt` — the endpoint
  lazy-imports it and returns 500 if absent (other endpoints unaffected). Before deploying force-
  align, regenerate the lock per its header (add `transformers`) and re-run pip-audit. Until then
  the aligner runs from the service venv (where it was validated).
- Remaining T3 wiring (separate PRs): ml-inference threads timing into the alignment response ->
  Rust persists non-zero start_ms/end_ms -> web sends audioBase64. Last-word END drifts into
  trailing silence (measure madd separately).

## ADR-0038 — Interface locale capability gates prevent untranslated UI claims

**Status:** Accepted through the 2026-07-19 readiness-recovery plan
**Deciders:** product owner (approved recovery plan), implementation team

> **Renumbered from ADR-0019.** This ADR was written as ADR-0019, a number already held by the
> pilot-invitations ADR above. Two decisions sharing one number is not merely untidy here:
> `checkAdr0022` in `scripts/cutover-readiness.mjs` resolves an ADR by `split("## ADR-00NN")[1]`,
> so a duplicated number silently resolves to whichever section appears first in the file. Nothing
> reads 0019 today, so nothing was misreported — but the next machine-read of a duplicated number
> would be wrong with no error. This one moved because nothing cites it by number, while
> `ADR-0019`'s pilot-invitations meaning is cited in the ADR-0020 context paragraph.

### Context

The web catalog declared Arabic `live` and Sorani `pilot` while
`apps/web/src/locales/` contained only English. The application correctly fell
back to English rather than fabricating religious-education copy, but it still
offered those locales to real users and flipped the document to RTL. That is not
a usable Arabic or Sorani interface. Separately, the reader has bounded,
verbatim Sorani verse translations; this is source content, not proof that
controls, consent, privacy, feedback, and errors are translated.

### Decision

Use the `localeCapabilities` registry as the one policy source for language
selection. A normal user can select only a locale with a recorded interface
capability. A source-language bundle records its path and key count; a future
translated bundle must also record full-key coverage, native reviewer, review
date, and review expiry. The normal selector and `?lng=` input resolve unavailable locales
to English. Test and smoke mode may enumerate the catalog only to exercise
fallback/direction regressions; that exception must not reach user builds.

Until reviewed packs exist, English is the only offered interface. Sorani verse
material remains a separately bounded, attributed capability and must not be
marketed as a Sorani UI.

### Consequences

- The product stops misrepresenting an English fallback as live/pilot Arabic or
  Sorani interface support.
- A product decision and explicit source/coverage labelling are required before
  exposing a bounded verse-translation control independently of the interface.
- The registry is a local truthfulness guard, not R5 proof. Native-language,
  Quran-content, RTL/accessibility, and candidate-bound review evidence are
  still required before a non-English interface can return.

## ADR-0021 — Agent-run dedup is application-level, not a DB unique constraint (for now)
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** The Tajweed Explainer batch re-recorded every finding on every tick, growing
`agent_runs` unboundedly and spamming the teacher review queue with duplicates. The obvious fix
is a DB unique constraint on `(tenant_id, finding_id)` — but `finding_id` lives inside the
`trace` JSONB, not a column, so that needs a new migration. New migrations currently can't ship
green: CI's Postgres only applies `infra/sql/0001–0013` (its list in the CI-protected
`.github/workflows/ci.yml`), so any integration test touching a new column fails `verify` — the
exact wall that's kept PR #123 red since 2026-07-07.

**Decision.** Dedup at the application layer instead (PR #193): `list_agent_runs` surfaces
`findingId` from the *existing* `trace` JSONB (no migration), and the batch skips findings that
already have a run. Sufficient because batches are sequential cron ticks, not concurrent.

**Options.** (A) DB unique constraint — bulletproof against concurrency, but blocked on the
`ci.yml` migration-list unblock. (B) App-level skip — ships now, CI-green, no schema change; not
atomic against two concurrent batch runs.

**Consequences.** Duplicates stop today. When the owner adds `0015–0020` (+#123's `0018`) to
`ci.yml`, promote to Option A in the same batch: migration adds an indexed `finding_id` column +
partial unique index, and `create_agent_run` uses `ON CONFLICT DO NOTHING`. Until then, a
hypothetical concurrent double-run could still double-record — acceptable for a single-tenant
cron pilot.

---

**Renumbered 2026-07-29 (was ADR-0013).** ADR-0013 on `main` is a different decision — release
gating of the mushaddad ghunnah limitation — so this one was a number collision, which is why the
PR could never merge cleanly. Content is unchanged apart from the number and this note.

**Status update 2026-07-29 — the constraint this ADR was written around is gone.** Two of its
premises no longer hold: CI now applies migrations `0001–0021` (not `0001–0013`), and PR #123 was
closed as obsolete because the agent-run erasure fix had already landed on `main` by another path
(`0018_agent_run_learner_id.sql` + `privacy.rs:356` + `privacy_delete_erases_learner_agent_runs`).
So the "blocked on the ci.yml migration list" reason for choosing Option B has expired, and Option A
(the DB unique constraint) is now shippable whenever the owner wants it. The app-level dedup remains
correct and in place; this is no longer a forced choice, just an unpromoted one.

## ADR-0022 — Deployable artifacts must be immutable and digest-pinned, so rollback has a target
**Date:** 2026-07-30 · **Status:** Accepted (2026-08-01, option A) · **Deciders:** repo owner + whoever owns ops

**Context.** `docker-compose.yml` builds every application service from source (`build:`); only
`postgres` uses `image:`. No workflow builds or pushes a container image — `grep -i
"docker build|docker push|ghcr|registry|docker/build-push"` across `.github/workflows/` returns
nothing. So there is no artifact anywhere that represents "the version that was running".

Consequently **rollback today means `git checkout <old-sha> && docker compose build`** — a rebuild,
not a rollback. It takes minutes instead of seconds, and it can fail for reasons unrelated to the
code being restored. That is not hypothetical: when GHSA-r28c-9q8g-f849 (postcss) published, `pnpm
audit` failed on every branch including `main` at a commit that had passed CI hours earlier (#261).
A rollback attempted in that window would have failed at the build step, at exactly the moment it
was needed.

The release-evidence machinery already assumes this is solved. `scripts/release-manifest.mjs:179`
defines `assertImageDigests()`, `:241-243` requires build-provenance digests to match the build
summary, and `scripts/release-challenge.mjs:248` forwards `RELEASE_IMAGE_DIGESTS_JSON`. **The
evidence model and the deploy model disagree, and the deploy model is the one that is wrong.**

**Decision.** Deployables become immutable images identified by digest. `docker-compose.yml` gains an
image reference per service, tagged from the git SHA at build time, with the previous tag retained so
there is always a target to return to. `imageDigests` is populated for real, satisfying the manifest
verifier that already demands it rather than relaxing the verifier to match reality.

**Options.**
- **(A) Local tag retention.** Build and tag locally (`qrai/<service>:<git-sha>`), keep the last N.
  No credentials, no network dependency during an incident. But tags live only on the host that
  built them — a replacement host has nothing to roll back to, so it is not disaster recovery.
- **(B) Registry (GHCR).** Push digest-pinned images from CI. Survives host loss, gives a real
  provenance chain, and is what the manifest verifier was designed for. Costs CI credentials and
  makes a rollback depend on registry availability during an incident.
- **(C) Do nothing.** Keep rebuilding. Rejected: it makes P5.5 permanently unprovable, and the
  postcss episode shows the failure mode is real rather than theoretical.

**Recommendation: (B), with (A) as the interim** — (A) is a few lines and makes rollback rehearsable
immediately; (B) is what makes it disaster recovery. Do not let (A) become the resting state.

**Consequences.**
- Rollback becomes `docker compose up -d` against a pinned digest: seconds, and immune to a broken
  build or a moving upstream dependency.
- Everything that drives compose is affected — `docs/STAGING_RUNBOOK.md`, the `scripts/smoke-*.mjs`
  family, `monitoring/docker-compose.monitoring.yml`, and CI if images are built there.
- Under (B), an incident acquires a dependency on the registry being reachable. That trade is
  deliberate and should be stated in the runbook, not discovered during an outage.
- Storage grows with retained tags; a retention count is needed, mirroring `backup-db.sh`'s.

**ACCEPTED 2026-08-01 — option (A), local tag retention.**

The owner chose (A). This ADR recommended **(B) with (A) as the interim** and warned "do not let (A)
become the resting state", so the divergence is recorded here rather than left implicit.

What (A) delivers — `scripts/release-images.mjs` + `.github/workflows/release-image.yml`:
- a STABLE tag per service per commit (`qrai/<service>:<short-sha>`), so a specific commit's image
  can be named later;
- the image DIGEST, published as a build artifact, satisfying `release-manifest.mjs`'s
  `assertImageDigests()` with real values rather than relaxing the verifier to match reality;
- RETENTION of the last N, so the previous image still exists when the current one turns out to be
  wrong. The retention rule is a pure function with its own test, run BEFORE any pruning: a bug
  there deletes the image you were about to roll back to.

**What (A) explicitly does NOT deliver, and this is the part to keep visible:**
- **It is not disaster recovery.** The tags live only on the host that built them; a replacement
  host has nothing to roll back to. `P5.6` (DR drill) is therefore NOT satisfied by this and must
  not be marked as though it were.
- It gives no provenance chain outside that host, so nobody else can verify what ran.

`docker-build.yml` is unchanged and is NOT this: it builds every image to verify the Dockerfiles and
the non-root hardening, producing no stable identifier, no digest and no retention.

**Revisit (B) when** the pilot runs on a host the team does not personally control, or when anyone
outside the build host needs to verify a deployed digest. Neither is true today; both are
foreseeable.

**Status note.** Proposed, not accepted: this is an architectural change to how the system is
deployed and the owner has not chosen between (A) and (B). **P5.5 cannot close until it is decided
and rehearsed** — a rollback rehearsal performed before this lands would be rehearsing a rebuild.

---

## ADR-0023 — Node tests talk to Postgres through `pg`, not a `psql` subprocess
**Date:** 2026-07-31 · **Status:** Accepted (Phase 6, `specs/api-parity-suite/plan.md` §7) · **Deciders:** repo owner

**Context.** Phase 6 adds a black-box `node:test` suite that must assert on database state — 23 of
the 77 Rust integration tests do (`specs/api-parity-suite/research.md §3`), and those are exactly the
assertions the Phase 5 fixture differ structurally cannot make, because it only sees HTTP responses.

Before this ADR there was **no Postgres driver in the repository**: `grep -rn '"pg"'
--include=package.json .` returned nothing. Node reached the database by shelling out to `psql`
(`scripts/smoke-sql.mjs:162`, with a `PSQL` path override at `:414`).

**Decision.** Add `pg` (node-postgres) as a **root devDependency**. All database access in the parity
suite goes through a single `queryJson()` function in `tests/api-parity/lib/harness.mjs`.

**Why not the `psql` subprocess, which needs no new dependency.** `psql` is not guaranteed to be on
PATH — verified absent on the maintainer's own machine while planning this phase, though present in
CI via the `postgres:16-alpine` service. A suite that depends on it would **silently skip** where it
is missing. That is the skip-if-missing anti-pattern MIG5 rejected in as many words: *"a soft skip
would report green on a machine with no Python and hide exactly the class of bug this exists to
catch."* A test suite whose security assertions vanish on some machines is worse than one that isn't
written, because the gate still prints green.

Secondary: Phase 7's Node backend needs a Postgres driver regardless. Choosing one now, while the
blast radius is test-only, is cheaper than choosing it under delivery pressure.

**Consequences.**
- `pg` enters the `pnpm audit` supply-chain gate (P4.4). Checked at adoption: `pnpm audit
  --audit-level moderate` → *No known vulnerabilities found*. It is a mainstream, low-churn package,
  but this is a real new surface, not a free one.
- **dev-only.** It must not become a runtime dependency of any shipped artifact without a new ADR.
  The Rust services keep using `sqlx`; nothing in `apps/web` imports it.
- Reversible for one file's cost: `queryJson()` is the only place the driver is named. If a future
  constraint forbids the dependency, that function is rewritten to shell out to `psql` and the 26
  tests are untouched — but the skip-vs-fail rule above must then be enforced explicitly.
- This ADR takes **no position** on which driver Phase 7's backend should use for production traffic
  (pooling, prepared statements, and RLS transaction pinning are different requirements). That is a
  separate decision on its own evidence.

## ADR-0024 — One security switch becomes six named ones; the blunt name survives as a deprecated alias

**Status:** Accepted (2026-08-01). **Context:** `specs/insecure-defaults-split/` ·
supersedes the unimplemented `specs/flutter-node-migration/plan.md §2.6`.

**Context.** `ALLOW_INSECURE_DEFAULTS` disabled **six independent controls** across two services
through **seven read sites** and thirteen assertions: every secret-strength boot panic, the
superuser/`BYPASSRLS` DB-role assertion, `/metrics` fail-closed in both services, the entire CSWSH
`Origin` allowlist, its missing-`Origin` fail-closed branch, and chaos fault injection.

The operational pressure is specific and imminent. A native/Flutter client sends **no `Origin`
header**, and the gateway fails closed on that. "Mobile can't connect" leads an operator to the one
variable that also ships a known-public JWT signing key, a DB role that makes all 16 RLS policies
inert, an internet-reachable `/metrics`, and a gateway that will drop sockets on command.

**Decision.** Split into `ALLOW_INSECURE_SECRETS`, `ALLOW_SUPERUSER_DB_ROLE`, `METRICS_DEV_OPEN`,
`GATEWAY_ALLOW_MISSING_ORIGIN` and `ALLOW_CHAOS_INJECTION`. Keep `ALLOW_INSECURE_DEFAULTS` as a
working alias that relaxes everything, with a loud boot warning and a **refusal to start** if it is
set alongside any per-control variable.

**The load-bearing part is narrower than a rename.** `GATEWAY_ALLOW_MISSING_ORIGIN` relaxes *only*
the missing-`Origin` branch: a request that carries an `Origin` is still checked against the
allowlist. A native deployment gets exactly the relaxation it needs and **browsers keep their CSWSH
protection**. Disabling the allowlist outright has no legitimate deployment, so it stays reachable
only through the deprecated name. Pinned by
`realtime-gateway/src/lib.rs::missing_origin_knob_does_not_disable_the_allowlist`, whose second
assertion is that a disallowed origin is still 403.

**Rejected: inventing `APP_ENV` so the alias could panic in production.** §2.6 asked for "a boot
assertion that it is never set in production". Neither service knows what environment it is in, and
adding a variable to find out is the same mistake in a new costume — plus a service that panics
because `APP_ENV` was forgotten is a new outage mode. Instead:
`tests/security/legacy-insecure-flag.test.mjs` fails the build if a committed production artifact
ships a relaxation switched on. **That is strictly weaker** — it cannot catch an operator exporting
the variable by hand — and both `insecure.rs` modules say so in place rather than implying coverage
they do not have.

**Rejected: fixing the `"1"`/`"true"` asymmetry.** `platform-api/src/lib.rs` accepted `"1"` alone at
the `/metrics` gate while every other site accepted `"1"` or `"true"`, so
`ALLOW_INSECURE_DEFAULTS=true` skipped the boot checks and still left `/metrics` closed.
`tests/api-parity/metrics.test.mjs` **depends** on that combination. The asymmetry is carried forward
verbatim **inside the deprecated alias only**; the new names are consistent everywhere. The parity
suite therefore passes **unchanged**, which is the sharpest available evidence that backwards
compatibility actually held.

**Consequences.**
- Two hand-maintained copies of a ~25-line resolver (`services/*/src/insecure.rs`). A workspace crate
  for that buys a dependency edge and nothing else; `shared-ticket` exists because a *wire format*
  must not diverge, which this is not. The copies genuinely differ, and a test asserts they agree on
  the alias name.
- `ALLOW_INSECURE_DEFAULTS` still works, so this **reduces the pressure** to reach for the blunt
  instrument without removing it. Removal is a separate breaking change and needs its own ADR.
- Setting the old and new variables together is now a **boot failure**, not a merge. Any deploy doing
  both must pick one.

## ADR-0025 — The Node port needs a bcrypt implementation, and there is no way around it

**Status:** Proposed (2026-08-01). **Context:** `specs/migration-completion/` N12b.

**Context.** `POST /v1/auth/register` and `POST /v1/auth/login` are the last two routes in the
approved port that cannot be written with what this repo already has. `register` writes
`bcrypt::hash(password, 12)` and `login` verifies against that stored hash
(`services/platform-api/src/handlers/user.rs:89,179`). Both implementations must accept each
other's hashes for the whole strangler period — a learner who registers against Rust must be able
to log in against Node on the very next request, and the reverse.

The ladder was walked before proposing a dependency, and every rung fails:

| rung | verdict |
|---|---|
| Does it need to exist? | Yes. `login` cannot verify a stored bcrypt hash without bcrypt. |
| Already in this repo? | No. `jose` (JWT), `postgres`, `pg`, `fastify`, `ajv`, `zod`, `yaml`. |
| `node:crypto`? | **No bcrypt.** `scrypt`, `pbkdf2` and `hkdf` are present and are different KDFs producing incompatible hashes. |
| A few lines of our own? | **Absolutely not.** bcrypt is Blowfish with a modified key schedule; a hand-rolled version is the canonical example of a security primitive nobody should write. |

**Decision.** Add ONE new runtime dependency to the Node service for bcrypt.

**Options.**

| | `bcryptjs` | `bcrypt` (node.bcrypt.js) |
|---|---|---|
| Install | pure JS, no compiler, no `node-gyp` | native addon, needs a toolchain per platform |
| Speed | ~3× slower than native at cost 12 | faster |
| CI/container risk | none | a prebuilt-binary miss turns into a source build inside the image |
| Supply chain | one package, no install scripts | native build scripts run at install |

**Recommendation: `bcryptjs`.** Cost 12 is *deliberately* expensive — hundreds of milliseconds by
design — so the constant factor between the two is small relative to the work bcrypt is doing on
purpose. In exchange the container stops needing a build toolchain and the install stops running
scripts. The Rust handler already moves hashing to `spawn_blocking` because it is CPU-bound; the
Node port needs the equivalent care regardless of which library is chosen, since a synchronous
hash at cost 12 blocks the event loop for the whole service.

**Consequences.**
- Easier: `register`/`login` become portable, which is the last blocker on N12.
- Harder: one more thing to audit, and `pnpm audit` gains a package that handles credentials.
- To revisit: if the platform ever ships a bcrypt primitive, or if the product moves to Argon2id —
  which would be a *better* password hash but is a migration of every stored credential, not a
  swap, and is out of scope for a port whose entire contract is behavioural identity.

**Not decided here.** Whether to keep bcrypt at all. Argon2id is the modern recommendation, but
changing the KDF is a data migration with a rehash-on-next-login path and its own spec. A port must
not quietly change how credentials are stored.

**Action items.**
1. [ ] Owner accepts or rejects this ADR (a new runtime dependency handling credentials).
2. [ ] If accepted: add `bcryptjs`, port `register`/`login`, and prove interoperability with
       cross-language vectors generated **from Rust** — Rust-hashed passwords verified in Node and
       Node-hashed passwords verified in Rust. A same-implementation round trip proves nothing.
3. [ ] Hash off the event loop, and assert it.

---

## ADR-0026 — The Flutter client needs a microphone and a socket, and neither is in the SDK

**Status:** Accepted (2026-08-02, on the owner's instruction to build the app)
**Deciders:** repository owner
**Supersedes / superseded by:** none

### Context

The 2026-08-01 audit found `apps/flutter` was eight library files: no entry point, no host projects,
**no recorder and no WebSocket**. `FL5` had shipped a consent gate over an `AudioRecorder` interface
with no implementation behind it, which is why the gate could be tested and the app could not run.

The owner reviewed that finding and instructed the work to proceed, in a message that named the
recorder and the WebSocket explicitly. AGENTS.md requires an ADR for a new runtime dependency; this
records what was added and why, so the choice is reversible by argument rather than by archaeology.

### Decision

Two runtime dependencies in `apps/flutter/pubspec.yaml`:

| package | version | what it does | why not the SDK |
|---|---|---|---|
| `record` | 7.1.1 | PCM16 microphone capture via `startStream` | Flutter has **no** microphone API. There is no stdlib alternative at any rung of the ladder. |
| `web_socket_channel` | 3.0.3 | cross-platform WebSocket | `dart:io`'s `WebSocket` would cost zero dependencies but **does not exist on web**, and web is currently the only target this machine can run and screenshot (`research.md §1`: no Xcode, no Android cmdline-tools). |

`web_socket_channel` is the weaker of the two justifications and is written down as such: on a
machine with Xcode it would be a genuine choice rather than a forced one.

### Options considered

**(A) Both dependencies — chosen.** The app runs on the one target available here, and the same
code path serves iOS and Android unchanged.

**(B) `record` + `dart:io` WebSocket.** One dependency instead of two, but no web build — so the
only proof available on this machine would be `flutter test`, which is exactly the "components, not
a client" state the audit objected to. Rejected because it would have made the fix unverifiable.

**(C) Neither — keep the interface, ship no implementation.** This is the status quo the audit
called a P0. Rejected.

### Consequences

- **Easier:** the practice flow exists and runs; `streaming_recorder_test.dart` drives the whole
  transport with an injected socket and PCM stream, so ordering is asserted without a microphone.
- **Harder:** two more packages in the supply-chain surface, both with platform channels. Neither is
  reachable from `services/`, so the API attack surface is unchanged.
- **Revisit if:** iOS/Android become the only shipped targets. Then (B) drops
  `web_socket_channel` for `dart:io` at the cost of the web build.

### What this ADR does NOT decide

Whether the Flutter client replaces `apps/mobile` (Expo). It does not: both exist, and the owner has
not been asked. `FL9` — the device matrix — remains open and is not satisfied by a web build.

### Action items

1. [x] Add both packages, with the versions pinned in `pubspec.lock`.
2. [x] Assert transport ORDER without hardware: socket before microphone, and no microphone at all
       when the gateway refuses the ticket.
3. [ ] Re-evaluate `web_socket_channel` when a machine with Xcode is available.

---

## ADR-0027 — A teacher's decision changes the finding, so the review queue is not a dead end

**Status:** Accepted (2026-08-02, on the owner's instruction — "wire it")
**Deciders:** repository owner
**Supersedes / superseded by:** none

### Context

`create_teacher_review` recorded a decision in `teacher_reviews`, wrote an audit event, and stopped.
Nothing in the platform ever updated `tajweed_findings.review_status` — verified by
`grep -rn "UPDATE tajweed_findings" services/platform-api/src`, which returned nothing, and there
was no database trigger either.

The consequence was total and silent. `canShowLearnerFacingAiOutput` admits only `teacher-reviewed`
and `scholar-approved`. `services/ml-inference` stamps every finding `ai-suggested`. So **no finding
could ever become learner-visible by any path**: a teacher could accept every item in the queue,
every evening, and no learner would see anything change. `docs/readiness/TRUE_READINESS.md` recorded
the symptom ("a learner gets the *scaffold*, not the *coach*") without naming the missing write.

Building the Flutter review queue (`apps/flutter/lib/src/review/`) forced the question, because a
review console whose decisions provably reach nobody is a facade.

### Decision

`create_teacher_review` promotes the finding in the **same transaction** as the review row and the
audit event, in both implementations (`handlers/review.rs` and `node-api/routes/review.mjs`):

| decision | `tajweed_findings.review_status` becomes | why |
|---|---|---|
| `accepted` | `teacher-reviewed` | the status the learner gate already admits |
| `rejected` | `blocked` | an explicit refusal, distinguishable from "not looked at yet" |
| `edited` | **unchanged** | see below |

`edited` promotes nothing. It means the teacher rewrote the explanation, and there is nowhere to put
the rewrite: `teacher_reviews.note` is free text that no reader folds back into the finding.
Promoting would publish the ORIGINAL wording as teacher-approved — precisely the text the teacher
said was wrong. The finding stays pending and stays in the queue, which is the truth about it.

One transaction, deliberately: a promotion without its audit trail is learner-facing content nobody
can account for, and a review row whose promotion was lost is a teacher's decision silently dropped.
Either half alone is worse than neither.

### What this decision actually means

**One teacher's acceptance is now sufficient to show AI-generated feedback about a person's
recitation of the Qur'an.** That is the substance of this ADR, not the SQL. It was the owner's call
and it is recorded here so it can be revisited by argument.

The other three requirements are unchanged and still enforced: a promoted finding is shown only if
it also carries at least one source and clears the 0.82 confidence floor
(`canShowLearnerFacingAiOutput`, mirrored in `apps/flutter/lib/src/api/models.dart` and pinned by
`tests/contract/tajweed-gate-parity.test.mjs`). Promotion is necessary, not sufficient.

### Consequences

- The teacher half of the loop closes: a decision now reaches the finding and changes its status.

**Both missing links are now closed** (2026-08-02, same day, on the owner's instruction "do both"):

1. **Findings are persisted.** `proxy_ml` writes them after a tajweed prediction
   (`ml_proxy.rs::persist_tajweed_findings`). Three constraints shape it: a finding must anchor to a
   real `word_alignments` row (fabricating one would invent `heardText`/`startMs` for audio nobody
   aligned, so unanchorable findings are skipped and counted); it writes **once per session**,
   because `persist_session_alignments` cascades `teacher_reviews` away on re-write and a learner
   tapping stop twice must not destroy a teacher's completed review; and the tajweed model is
   resolved by `kind` rather than from the response, which reports `ml-aligner-v0.2` — an
   *alignment* model, and not a `model_versions` row at all.
2. **The learner can read them.** `GET /v1/recitation-sessions/{id}/tajweed-findings`, scoped by
   `require_self_or_any(learner_id, [Teacher, Admin, Ops])` — ownership, not role. It returns
   withheld findings too, with their status, so the client can distinguish "3 notes are waiting for
   a teacher" from "no feedback"; `canShowLearnerFacingAiOutput` still decides what is displayed.

`tajweed_findings_persist_and_the_learner_can_read_their_own` drives the whole chain against live
Postgres: analyse → persist → teacher accepts → the learner reads it back as `teacher-reviewed`,
satisfying every term of the gate.

The chain needs alignments, and the Flutter practice flow produced none — it streams to the realtime
gateway, which forwarded audio chunks and computed nothing. Closed the same day by action item 5:
the gateway's audio is transcribed where it lands (`ml-inference /v1/session-transcript`) and
`POST /v1/recitation-sessions/{id}/finalize` derives and persists the alignment server-side, without
letting the client say what the learner recited.

**What remains unproven.** The whole chain has only ever run against a MOCKED ASR. Assembly,
ordering, session scoping and the consent refusal are covered
(`services/ml-inference/session-transcript.test.mjs`), but the accuracy of a real Whisper transcript
— and whether the alignment it yields is fair to a learner — has not been measured. That needs the
real service and someone who can judge Quranic recitation; it is not a test this repo can write.

### Action items

1. [x] Promote in `handlers/review.rs`, in the existing transaction.
2. [x] Mirror in `node-api/routes/review.mjs`; the parity suite keeps the two honest.
3. [x] Integration coverage against live Postgres for all three decisions, including that `edited`
       changes nothing and that a promoted finding then passes the learner gate.
4. [x] Persist computed tajweed findings, and give a learner a route that reads their own session's
       persisted findings. Both landed 2026-08-02; the chain is covered end to end against live
       Postgres.
5. [x] Give the Flutter practice flow an alignment step, or have the gateway produce alignments.
       Done 2026-08-02 as the latter, on the owner's instruction. The gateway's audio is transcribed
       where it already lands (`ml-inference /v1/session-transcript`) and
       `POST /v1/recitation-sessions/{id}/finalize` derives and persists the alignment server-side.
       The client supplies nothing about what was said — whoever supplies the recognised words
       decides what the learner is recorded as having recited.
6. [x] Decide whether teacher acceptance should refuse a sourceless finding, as scholar approval
       does. Done 2026-08-02, on the owner's instruction: it refuses, in both implementations,
       BEFORE any write — so a refused acceptance leaves no row and no audit trail implying one was
       considered. Only `accepted` is refused; rejecting or editing an unsourced finding is what a
       teacher should be able to do with one, and refusing those would trap it in the queue. The
       Flutter review card disables Accept for the same case rather than letting a teacher spend
       judgement on a 400.

---

## ADR-0028 — The learner gate is enforced on the wire, not in the client

**Status:** Accepted
**Date:** 2026-08-02
**Context:** readiness-recovery-10-10 P3.2 (withheld-feedback and provenance tests)

### Context

The platform rule is that no AI judgement about someone's recitation reaches them before a human
approves it, with a source and enough confidence. That rule had four implementations — TypeScript
(`canShowLearnerFacingAiOutput`), Dart (`isLearnerVisible`), and two Rust/Node copies for agent runs
— and `tests/contract/tajweed-gate-parity.test.mjs` kept the first two honest with each other.

Every one of them was a **client-side filter**. Both learner-facing routes returned unreviewed
findings in full — `rule`, `severity`, `explanation`, `wordId`, `confidence`, `sources` — and relied
on the browser or the app to hide them:

- `GET /v1/recitation-sessions/{id}/tajweed-findings`
- `POST /v1/ml/tajweed-findings:predict` — where *everything* is `ai-suggested` by construction

The route's own doc comment defended this: "a COUNT of pending notes is not a judgement about the
recitation". The argument is right. The code did not implement it — it shipped the judgement and
counted on the UI not to render it. `curl` with the learner's own token read all of it, and so would
any client that forgot the rule. This is the same shape as ADR-0027 item 6, found the same way.

### Decision

Both routes redact server-side for a learner. A finding that does not clear the gate **keeps its row
and its `reviewStatus`** and loses everything that is a judgement: `rule`, `severity`, `explanation`
and `wordId` become empty, `confidence` becomes `0`, `sources` becomes `[]`, and `withheld` is
`true`. Staff receive every finding intact — reviewing the unreviewed ones is the entire job.

Three things fall out of that shape:

1. **The count survives.** Both clients render "N notes are waiting for a teacher" from the array
   length (`hasWithheldFindings` in apps/web, the `isLearnerVisible` filter in apps/flutter). Neither
   needed changing.
2. **The redacted values fail the client gate on their own merits.** `confidence: 0` and
   `sources: []` are not placeholders — a client that has never heard of `withheld` still cannot
   display one as feedback. The two gates cannot disagree about a redacted row.
3. **`withheld` means the same thing to both audiences** — "not learner-visible" — so staff read it
   as "still pending" rather than needing a second field.

Each route's staff list is a single constant used for BOTH the authorization check and the redaction
decision (`STAFF` in review.rs, `ANALYSIS_STAFF` in ml_proxy.rs). Two copies would drift, and the
direction they would drift in is a learner reading an unreviewed judgement.

`ANALYSIS_STAFF` is admin/ops and deliberately excludes teachers: `proxy_ml` never allowed a teacher
to re-run the analyser against someone's session, and unifying the lists surfaced that a redaction
branch written for `Teacher` was unreachable.

### Consequences

**Easier:** the rule is now enforced where it can be relied on. A new client — a script, a partner
integration, a future native app — gets the safe behaviour without knowing the rule exists.

**Harder:** four implementations became six. `tests/contract/tajweed-gate-parity.test.mjs` now pins
the confidence floor across every one of them, recognising a gate by its provenance check following
the floor, so all six read the same way. Writing a seventh in a different shape fails the test.

**Newly proven:** `PARITY_THROUGH_SHELL=1` has existed since Phase 7 N2 and **no gate had ever run
it** — every gate exercised the Rust binary, so a Node handler could disagree with its Rust original
in any way and stay green. `verify.sh` now runs the ML-proxy parity suite through the Node port, and
the mirror was confirmed by disabling it and watching the suite go red.

### What this does NOT fix

- **`POST /v1/ml/tajweed-findings:predict` analyses CANONICAL text, not the learner's audio.**
  `predictTajweed` calls `getCanonicalWords(...)` and runs rule detection over the Quran passage. It
  inspects no audio, no heard text, no pitch and no timing. What it returns is "rules that apply to
  this passage", presented as findings about a recitation. Redaction makes the *withholding* honest;
  it does not make the *feature* honest. That is P3.4–P3.6 and a scholar's call, not an engineering
  one.
- **The web client still submits a learner-controlled transcript** (`recognizedText` in
  apps/web/src/App.tsx) which becomes persisted alignments and measured progress. The Flutter path
  derives it server-side; the web path does not.
- **The gateway does not forward `audioRetention`** to ml-inference, so a "teacher review" or
  "training opt-in" choice is not honoured downstream. — **FIXED, see ADR-0029.**

All three were found while closing this and are recorded here rather than fixed here, because each
is a product or architectural decision rather than a bug with an obvious right answer.

---

## ADR-0029 — The consent screen's retention question needed an answer nothing downstream could hear

**Status:** Accepted · **Date:** 2026-08-03 · **Supersedes:** the third open item under ADR-0028

### Context

`consent_records.audio_retention` has been a three-value column since the first migration — `discard`,
`teacher-review`, `training-opt-in` — and ml-inference has honoured all three since it was written:
its eviction sweep keeps `training-opt-in` indefinitely, `teacher-review` for seven days, and
everything else for one hour.

The two halves were never connected. The realtime gateway, which is what actually posts a learner's
audio to `POST /v1/audio-chunks`, holds no database and had no way to know the answer. So it sent a
body with no `audioRetention` field at all, ml-inference read `requestBody.audioRetention ?? "discard"`,
and every chunk from every session was labelled `discard` and deleted an hour later.

Nothing was logged, no test failed, and no code was wrong in isolation. The consent screen asked the
question, the database stored the answer, ml-inference was ready to act on it, and the answer never
crossed the gap between them. A learner who chose to keep a recitation for their teacher found it
gone; their teacher found nothing.

### Decision

Put the retention choice in the realtime ticket, and bump the ticket format `rt_v1` → `rt_v2`.

```
rt_v2.{session}.{tenant}.{learner}.{externalAsr}.{audioRetention}.{expiry}.{nonce}.{hmac}
```

The ticket is the only channel from platform-api to the gateway, and it is already HMAC-signed, which
is a requirement rather than a convenience: retention is a field a client would want to rewrite.
Upgrading `discard` to `training-opt-in` on an unsigned field would keep a child's voice forever.

`platform-api` joins `consent_records` when minting and signs the STORED value. The request body has
no say — the same rule `externalAsrProcessing` has always followed, for the same reason.

### Options considered

| Option | Why not |
|---|---|
| Give the gateway a database connection | A second service reading `consent_records` doubles the RLS surface and adds a per-chunk query to the hot path, to learn something already known at ticket time. |
| Have ml-inference look retention up itself | It has no tenant context and no Postgres; it would need both, and a chunk POST would become a cross-service round trip. |
| Send it unsigned as a header | A client-controllable retention field is a privacy hole, not a shortcut. |
| Add a fourth copy of the enum in shared-ticket | `tests/contract/enum-parity.test.mjs` exists because these sets drift. The ticket carries the value as an opaque non-blank string; the closed set stays owned by the DB CHECK constraint, and an unrecognised value degrades to `discard` — shortening retention, never extending it. |

### Consequences

- **A two-service deploy.** Field count went 8 → 9, so v1 and v2 tickets are mutually unparseable in
  both directions — the version tag makes that legible in a log instead of looking like corruption.
  Tickets live 300s, so a rolling deploy costs at most one TTL of refused upgrades; the client
  re-mints and reconnects. Deploy platform-api and realtime-gateway together.
- The six cross-language golden vectors were regenerated **from Rust** and now cover all three
  retention values. The generator is committed at `services/shared-ticket/tests/regenerate_vectors.rs`
  rather than thrown away, `#[ignore]`d so it never runs in CI.
- Two hand-rolled copies of the ticket format (`scripts/smoke-gateway.mjs`,
  `scripts/chaos-realtime-reconnect.mjs`) were deleted in favour of importing the pinned minter. Both
  had silently transcribed the wire format; both would have rotted on this change.

### How it is held

The unit tests were all green while this was broken, so the gate is an assertion on the artifact:
`tests/gateway/audio-retention-e2e.test.mjs` runs a real gateway and a real ml-inference, streams a
chunk over a real websocket, and reads the `.meta.json` on disk. Reinstating the bug turns it red
with `expected: 'teacher-review', actual: 'discard'` — the original failure, verbatim.

---

## ADR-0030 — A learner's own claim and the platform's own measurement are different things

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0028 (the learner gate), SHIP_PLAN P1.1

### Context

Two code paths write `word_alignments`, and once written the rows were identical.

`finalize_session` fetches the transcript **server-to-server** from the service holding the audio.
The caller names a session id and supplies no words.

The web practice loop does the opposite. It obtains a transcript — either from `/v1/asr/transcribe`,
which this API produces and then hands to the browser, or from the browser's own Web Speech API —
splits it client-side, posts it to `/v1/ml/alignments:predict`, and posts the result back to
`POST /v1/recitation-sessions/{id}/alignments`. Every word in that row originates from something the
caller sent. A caller can also skip the microphone entirely and post a flawless recitation.

Downstream, `/v1/learner/progress/weekly` averaged the two together and called the result
`accuracy`. A teacher promoting a tajweed finding to learner-visible feedback could not see which
kind of evidence it rested on. Both are the same failure: presenting a learner's claim as the
platform's measurement.

This is not a hypothetical attack. The ordinary, non-adversarial web flow produced rows the system
could not vouch for, and reported them as measured.

### Decision

`word_alignments.transcript_source` — `server-derived` | `client-reported`.

It is set by the **code path**, never by the request body: `finalize_session` passes
`ServerDerived`, the client-facing route passes `ClientReported` unconditionally, and the value is a
Rust enum rather than a string a handler could forward from input.

`accuracy` in the weekly endpoint now counts only `server-derived` words. Self-reported words are
returned as `wordsSelfReported`, so a day of real practice never renders as an empty day, and the
staff review queue carries `transcriptSource` on every finding.

The column defaults to `client-reported`. Every pre-existing row came from the web path, so the
default has to be the weaker claim; defaulting to `server-derived` would silently promote the entire
back catalogue to measured evidence, which is the exact failure being fixed.

### What this deliberately does NOT decide

**Whether self-reported practice should count toward a learner's progress.** It is recorded, it is
returned, it is named — and it is not averaged into a figure called accuracy. Making it count, under
its own label and with its own presentation, is a product decision for the owner. This change only
makes the decision possible by ending the conflation.

**It does not make the web path trustworthy.** It cannot: the Web Speech fallback is client-side by
construction. Routing the web client's audio through the realtime gateway, so it can finalize like
the Flutter client does, is the only thing that would — and that is a client architecture change,
not a column.

### Consequences

- A learner who practises only on the web now sees an **empty weekly accuracy chart** rather than a
  populated one. That is the point, and it is the same trade P1.1 made when it deleted the
  fabricated linear "week" derived from the mastery scalar. The chart already renders `null` as "no
  data" (`ProgressPanel.tsx:83`), so nothing breaks — but a learner will notice, and surfacing
  `wordsSelfReported` in the UI is worth doing before this reaches them.
- `wordsSelfReported` is a new field on a wire contract the Node port also serves; both
  implementations changed together and `progress-parity` asserts the shape.

---

## ADR-0031 — A teacher's judgement outlives the finding it was about

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0027 (a teacher decision changes the finding)

### Context

`persist_session_alignments` replaces a session's alignment on write. `tajweed_findings.alignment_id`
and `teacher_reviews.finding_id` both RESTRICT, so it cascaded: teacher_reviews → tajweed_findings →
word_alignments, all three DELETEd.

The route is authorised for the session **owner**. So a learner re-recording their own session
deleted any review a teacher had already submitted on it. A previous pass made the erasure visible —
the persist audit event records `deletedTeacherReviews` — and left the policy open as a product
decision.

Visibility was the right first move and it is not enough. An audit line saying a review was destroyed
is not the review. The record that a named teacher made a named decision about a named learner's
recitation, at a known time, is the kind of thing an institution is later asked to produce.

### Decision

Detach, do not delete.

`teacher_reviews.finding_id` becomes nullable, and the cascade sets it `NULL` with
`superseded_at = now()` instead of removing the row. That releases the RESTRICT so the finding can
still go — which is correct, it points at words that no longer exist — while the review, its author,
its decision, its note and its timestamp survive.

A detached review needs one more thing to be worth keeping: `reviewed_finding`, a JSON snapshot of
what the teacher was looking at, captured in the same read that validates the finding exists.
Without it a surviving review says "a teacher rejected something", which stops being evidence at the
point it matters most.

### What this does NOT decide

Whether re-recording should invalidate a teacher's review **at all** remains open. It still does; the
finding is still destroyed and the review is still marked superseded. This changes only whether the
record of the decision survives that, which is not a product question.

### A constraint that had to be removed

The first draft added a CHECK: a review with no `finding_id` must carry a non-empty snapshot. A
mutation test showed what it does to real data. Reviews written before this migration have
`reviewed_finding = '{}'` — their snapshot was never captured, and inventing one would be fabricating
evidence. Detaching such a row fails every arm of the check, so the constraint fires and a learner's
ordinary re-record returns 500.

The rule was right and the place was wrong. It is held by the write path instead, where every review
from now on gets a snapshot; legacy rows stay identifiable by `reviewed_finding = '{}'`, which is the
truth about them. Recorded because "add a constraint expressing the invariant" is the obvious move
and it was, here, an outage.

### Consequences

- `deletedTeacherReviews` keeps its name in the audit metadata although the reviews are now detached
  rather than destroyed. The number still answers what it was added to answer — how much review
  history this request affected — and renaming an audit-log field breaks every existing reader for a
  wording improvement.
- Any query counting teacher reviews now sees superseded ones. `superseded_at IS NULL` is the filter
  for live reviews; the index supports it.

---

## ADR-0032 — The production ASR model speaks a shape nothing read

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0030 (measured vs claimed evidence)

### Context

`services/asr-inference` picks its model from `ASR_MODEL`, and the two supported models reply in
different shapes:

| model | reply |
|---|---|
| `openai-whisper` (a bare size like `base`) | `words: [{word, start, end}, …]` **and** `text` |
| `tarteel-ai/whisper-base-ar-quran` — **the default** | `words: []`, recitation in `text` |

The HF Quran fine-tune is the production default and the whole point of the service: it returns
diacritized Quranic Arabic. Its 2022 checkpoint has no timestamp config, so it emits no word
segments — per-word timing comes from the separate `/v1/force-align` pass, which is why the service
was built that way.

Both readers in ml-inference took `.words` and nothing else:

```js
recognizedWords = asrResult.words.map((w) => w.word);        // predictAlignment
recognizedText:  (asr.words ?? []).map((w) => w.word),       // transcribeSession
```

On the default model both resolve to `[]`. `finalize_session` then aligns an empty transcript
against the full passage and records every word the learner recited as `missed`. Nothing throws,
nothing logs, and the response is a well-formed alignment of a recitation that never happened.

ADR-0030 had just made this the *only* kind of alignment counted as measured accuracy.

### Decision

One helper, `recognizedWordsFrom(asrResult)`, used by both readers. Word segments win when present —
deriving from `text` unconditionally would discard boundaries the whisper path does produce — and
otherwise the words come from `text`.

**Split, never normalise.** The split is on whitespace runs and nothing else: no diacritic
stripping, no NFC/NFD, no tatweel removal. Every code point inside a word crosses the function
unchanged, because it is Quranic text.

The HF branch also reported `duration: 0.0` for every request — a measurement never taken, presented
as one that was. It now reports the real container duration from `probe_duration_seconds`, which
ffprobe has already computed for the max-duration guard. `0.0` still means "the container would not
say", which is the truth rather than "zero seconds".

### How it was found, and a test that had to be fixed twice

The existing mock ASR returned **both** `words` and `text`. Only one of the two real dialects was
ever spoken to this code, which is why no test noticed.

The first version of the new alignment-path test passed under mutation — it omitted
`externalAsrRequested`, so `asrAllowed` was false, the ASR was never called, and the canonical
fallback satisfied the assertion. It now asserts `externalAsr.called` before anything else. This is
the fifth guard in this repo found to pass for the wrong reason, and the first one I wrote myself.
## ADR-0033 — A tajweed finding records whether it is about the text or about the person

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0028, ADR-0030 · **Supersedes:** the first open item under ADR-0029

### Context

`services/ml-inference/tajweed.js`:

```js
export function analyzeAyah(ayahId, words) {
  for (const word of words) allFindings.push(...analyzeWord(word.id, word.text));
```

`word.text` is the canonical Uthmani text of the passage. The analyser inspects no audio, no heard
text, no timing and no pitch. What it detects is **where a rule applies in the Quran** — a fact about
the passage, identical for every learner who ever recites it.

Those results are stored in `tajweed_findings`, a table whose own documentation describes a row as
"this word, in this recitation, was mispronounced", anchored to a `word_alignments` row as "the
evidence that the word was heard at all", and released to a learner once a teacher accepts it
(ADR-0028). ADR-0029 recorded this in prose — *"Redaction makes the withholding honest; it does not
make the feature honest"* — and left it there.

Nothing in the data said which of those two things a finding is. A teacher working the queue was
being asked to decide whether to tell a child they mispronounced a word, with no way to see that the
system had not listened to them.

### Decision

`tajweed_findings.analysis_basis` — `canonical-text` | `acoustic` — written as a **literal** at the
insert, not read from the ML response. Same reasoning as `TranscriptSource::ClientReported`
(ADR-0030): a value read from a response is one refactor away from being caller-controlled, and this
one decides whether a teacher trusts what they are looking at. When an acoustic analyser exists,
writing `acoustic` will be a deliberate code change with its own review.

Today every row is `canonical-text`, because that is the only thing the analyser can produce. The
column is worth having precisely then: it makes the gap legible in the data rather than only in a
doc comment, and it puts the fact in front of the person who has to act on it. The staff queue now
returns `analysisBasis` alongside `transcriptSource`, which answer different questions — whether the
platform heard the recitation at all, and whether this judgement came from it.

### What this does NOT decide

Whether a `canonical-text` finding should be shown to a learner as feedback about their recitation.
That is a scholar's and the owner's call (SHIP_PLAN P3.4–P3.6). `clears_learner_gate` is untouched:
an accepted finding is still released exactly as before. This makes the question answerable; it does
not answer it.

### Known gap, not fixed here

`GET /v1/teacher-review-queue` returns `findingId: ""` for a review detached by ADR-0031, with
nothing saying why. `superseded_at` is on the row but not on the wire. Left out deliberately to keep
this change to one subject — recorded so it is a gap someone can find, not one they have to
rediscover.

---

## ADR-0034 — A port is only ported where something compares it

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0030 (drift found the same way)

### Context

All 36 portable routes had been ported (N7–N19; `N12b` register/login remains blocked on ADR-0025).
`scripts/verify.sh` ran the black-box A/B suite through the Node port for **two** of them:

```
NODE_API_PORTED='POST /v1/ml/tajweed-findings:predict,POST /v1/ml/alignments:predict'
```

Scoped that way for a good reason at the time — those two hold a copy of a learner-facing rule — and
the line's own comment said so: *"Widening the list is how the rest of the port earns the same
proof."* It was never widened. Thirty-four routes were ported, reviewed, merged and shipped with
nothing anywhere comparing them to the Rust original.

This is the same shape as the gap that comment was written to close. `PARITY_THROUGH_SHELL=1` had
existed since Phase 7 N2 with no gate running it at all; the fix ran it over 2 routes and the
remaining 94% inherited the original problem.

### What running it found

One real divergence, on the first attempt, across **fourteen** surfaces.

Postgres text cannot hold U+0000. Rust translates the resulting SQLSTATE into a 400 naming the
problem (`impl From<sqlx::Error> for ApiError`). The Node port never mirrored it, so the same input
answered `500 {"error":"internal error"}` on session-create, progress, agent-runs, teacher-reviews,
scholar-approvals, realtime tickets, invitations, privacy-export and four path-parameter routes: bad
input reported as a server fault, with nothing telling the caller what to fix.

Fixed in the shared error handler, where Rust puts it, so all fourteen close at once — and with the
same two SQLSTATEs, not one. `22P05` (jsonb) was added to the Rust original after measuring that the
same byte produces a different code by column type; a port that copied only `22021` would have
inherited exactly one route's worth of the bug.

### Decision

The gate runs the full parity suite through the Node port over **every** route in `PORTABLE` — 243
assertions, up from 14 — and the route list is **read out of `server.mjs` at gate time** rather than
written into `verify.sh`. A hardcoded list is a second place to remember, and the forgotten one is
always the gate: a route added to `PORTABLE` would be servable in production with nothing comparing
it to anything.

The parser fails loudly if it reads fewer than 30 routes, because a regex that silently matches
nothing would report a green run over an empty set.

### Consequences

- The gate is slower: the parity suite now runs twice, once per backend. That is the cost of the
  claim, and the claim is the one thing that makes a cutover decidable.
- **This does not enable anything.** `NODE_API_PORTED` stays empty at runtime and `traffic-share`
  stays UNMET. Parity is one of four gates the brief names (parity, rollback, security, operations);
  it is now measured rather than assumed.

---

## ADR-0035 — Backups are encrypted to a key the backup host does not have

**Status:** Accepted · **Date:** 2026-08-04 · **Related:** ADR-0031 (P5.6), ADR-0022 (still owner-held)

### Context

`scripts/backup-db.sh` wrote `pg_dump --format=custom`. `scripts/backup-audio.sh` wrote `tar -czf`.
Both are **compression**, and this project had been treating them as though they were
confidentiality. The database dump holds learner accounts, consent records and progress; the audio
archive holds raw recordings of children reciting. Both were readable by anyone with access to the
backup directory — or to the off-host bucket that `docs/BACKUP_RESTORE.md` instructs operators to
copy them to, which is the copy that lives longest and is watched least.

This was found during a row-by-row audit of the twelve ledger rows marked "engineering in place",
and then **deliberately not fixed**, on this reasoning:

> Cipher choice plus key custody and rotation is an ADR the owner owns. I will not invent a
> key-management scheme for children's audio in a drive-by commit.

That reasoning was wrong, and the way it was wrong is worth recording, because it is a general
failure mode: **it assumed the only design was a symmetric one.** Under a shared-secret scheme the
backup host must hold the key, so key custody genuinely is an unavoidable, owner-owned decision, and
deferring is correct. The deferral inherited that constraint from an unexamined assumption rather
than from the problem.

### Decision

**CMS envelope encryption (RFC 5652) with AES-256-GCM, addressed to a recipient certificate.**

Encryption requires only the recipient's **public** certificate. That single property removes the
blocker entirely:

- The backup host holds **no secret** and cannot decrypt its own backups. Compromising the machine
  that stores every backup yields ciphertext, which is the threat that actually matters.
- The private key is generated once by the owner, offline, and never appears in this repository, in
  an environment variable, in CI, or in any process this tooling runs. **The tooling never creates a
  key** — the same rule already applied to the release keystore.
- There is no shared secret to rotate when staff change, and no passphrase to leak through a `ps`
  listing, a shell history, or a CI log.

So key custody is not a decision the tooling makes, which is precisely why this could be implemented
rather than deferred. Generating the keypair remains the owner's one manual step and is documented
in `docs/BACKUP_RESTORE.md`.

**AES-256-GCM** because it is authenticated: a flipped byte makes decryption *fail* rather than
return plausible garbage. For a backup, that is the difference between a loud failure and a corrupt
restore nobody notices.

**Fails closed, with no opt-out.** No `BACKUP_ALLOW_PLAINTEXT` flag exists, and
`scripts/backup-crypto.test.sh` greps to keep it that way. An override is how a guard becomes
decorative: it gets set once during an incident and never unset. Without a configured recipient, no
backup is written and the script exits 2.

### Consequences

- **Losing the private key means losing every backup.** That is the design working, not failing. The
  runbook requires two copies in separate physical locations before the first real backup, and
  requires retired keys be kept for as long as anything encrypted to them is retained.
- **The backup path never puts plaintext on disk** — `pg_dump` and `tar` are piped straight into the
  encryptor, so there is no window and no cleanup step a crash can skip.
- **The restore path does.** `pg_restore` seeks, and `--jobs` needs a real file, so the dump is
  decrypted under `mktemp` with `umask 077` and removed by a trap on every exit path. Audio restore
  has no such window: `tar -xz` reads the decrypted stream directly. This asymmetry is real, is
  bounded, and is written down rather than smoothed over.
- **The audio backup's file-count check got weaker.** It used to read the archive back with
  `tar -tzf`; the host now cannot, having no key. It instead counts what `tar` reported archiving —
  still a number produced independently of `find`, so it still catches a silent drop, but it no
  longer proves the archive reads back. That proof moved to the restore drill, where the key is
  present.
- **Existing plaintext backups are not migrated.** Both restore scripts accept an unencrypted
  archive and warn loudly, because refusing would make old backups unrecoverable. Their existence on
  disk is itself the exposure.
- **The T1 drill timing is now stale.** The measured `<1s` restore predates decryption. Re-timing it
  is part of the P5.6 drill, not something to estimate.
- P5.6 also requires a **timed point-in-time restore drill**, which this does not perform. Encrypted
  backup *verification* is now mechanised and gated; the drill remains open and human-run.

### What the test had to survive

`scripts/backup-crypto.test.sh` runs the real backup and restore scripts against a throwaway keypair
in `mktemp -d`. Its first version asserted confidentiality with `grep -qa "$marker" "$archive"` — and
a mutation run that replaced the encryption with `cat` **passed**, because gzip had compressed the
marker out of literal visibility. A guard that passes for the wrong reason is worse than no guard,
since it is counted as coverage. The assertion now asks three separate questions (is it listable as a
tar, does it carry the gzip magic, is the marker recoverable after decompression) and a plain
`tar.gz` control proves each one can discriminate.

## ADR-0036 — A text-derived finding asserts no confidence

**Status:** Accepted · **Date:** 2026-08-05 · **Related:** ADR-0033 (analysis basis), ADR-0028 (learner gate)

### Context

`services/ml-inference/tajweed.js` attached a per-rule confidence to every finding: ikhfa 0.80,
idgham 0.82, iqlab 0.83, tafkhim 0.84, madd-maleki 0.85, shaddah 0.86, qalqalah 0.87,
madd-tabii 0.88, ghunnah 0.90. Nine hand-typed decimals ranking the rules against one another with
nothing behind the ranking — no model, no dataset, no precision/recall, no evaluation.

The detectors themselves are fine: deterministic, and unit-tested against real Uthmani word forms
(`tajweed.test.mjs` pins bugs that were genuinely fixed). "The regex is correct" is simply not a
confidence, and the two were being conflated.

It was not cosmetic. `canShowLearnerFacingAiOutput` gates learner-visible AI output on
`confidence >= 0.82`, so those literals decided which rules a learner could ever be shown:

| rule | old value | vs the 0.82 gate |
|---|---|---|
| ghunnah, madd-tabii, qalqalah, shaddah, madd-maleki, tafkhim, iqlab | 0.83–0.90 | through |
| idgham | 0.82 | through, by exactly one hundredth |
| **ikhfa** | **0.80** | **permanently blocked** |

A teacher could review an ikhfa finding, approve it, and the learner would still never see it —
silently, because of a constant nobody chose for that purpose.

The response-level confidence was the mean of those numbers, and `0.95` when the analysis found
nothing at all: "we checked and are 95% sure there is nothing wrong", which nothing here can assert.

### Decision

A finding whose `analysis_basis` is `canonical-text` reports **`confidence: 0`** — no assertion.

`analyzeWord` reads the canonical Uthmani text and nothing else: no audio, no transcript, no timing.
"An ikhfa occurs here" is true of the passage and identical for every learner who ever recites it.
It is not evidence that a particular learner did anything. ADR-0033 already records that in
`analysis_basis`; this makes the number agree with it instead of contradicting it.

`0` is this codebase's existing idiom for "no assertion" — both learner-gate mirrors zero the
confidence when withholding (`ml_proxy.rs:215/245`, `routes/ml-proxy.mjs:106`).

The `0.82` threshold is NOT changed. It is mirrored in four places with tests on the boundary, and
it remains meaningful for `acoustic` findings, which will carry a measured confidence.

### Consequences

- Text-derived findings fail the learner confidence gate uniformly and by construction, rather than
  passing it on fiction. No rule is privileged over another by a typed constant.
- Staff are unaffected: they receive every finding. The analysis is for a teacher to read.
- **Existing rows are not migrated.** At the time of writing, staging holds 340 `canonical-text`
  findings that are `teacher-reviewed` with confidence ≥ 0.82. A teacher genuinely approved each, so
  the human gate is satisfied and retroactively hiding them is a product decision, not a defect fix.
  Recorded here rather than done quietly; the producer is fixed, the history is not.
- Making this a real number requires an acoustic analyser judged against adjudicated labels. That
  does not exist. Inventing a decimal here would not bring it closer, and did actively obscure the
  fact that it is missing.

## ADR-0037 — A teacher hears a recitation through platform-api, and every fetch is audited

**Status:** Accepted · **Date:** 2026-08-05 · **Related:** ADR-0028 (server-side gate), ADR-0031/0033, ADR-0036

### Context

A teacher opening the review queue is asked to accept or reject a claim about how a child recited.
Until now they could not hear the recitation, and nothing told them why: measured at the time of
writing, **all 2772 tajweed findings belonged to sessions whose consent said `discard`**, so the
audio had been destroyed on purpose and the queue looked identical to one where it was simply
unplayed. ADR-0036 and the `audioStatus` field made that legible. This is about the case where the
recording *does* exist.

Audio is written by realtime-gateway into ml-inference's object storage. Nothing could read it back:
ml-inference had a store route and no read route at all.

### Decision

**The bytes travel through platform-api.** A teacher's client never talks to ml-inference and never
receives a URL that would let it. platform-api resolves the finding, checks the tenant, checks the
role, checks consent, writes the audit event, and only then asks ml-inference for the object.

The alternative was a short-lived signed URL issued by ml-inference. It is faster and it moves the
bytes off the platform's critical path, and it was rejected for one reason: a URL that grants access
is a credential that outlives the check that produced it. It cannot be revoked when consent is
withdrawn mid-window, it appears in whatever the client does with it, and the audit record would
say a link was *issued*, not that a recording was *heard*. Slow and accountable beats fast and
approximate for a child's recorded voice.

**Every fetch is audited**, as its own `audit_events` row, written before the bytes are served so a
transfer that fails halfway is still recorded as an attempt. Auditing begins after authorization
succeeds: an unauthenticated caller must not be able to write rows into the audit log.

**ml-inference takes the object key's PARTS, never the key.** `<tenant>/<learner>/<chunk>.bin` as a
single string would mean filtering a path-shaped value for traversal on the one route that reads
files off the host. Three segments through `safeStorageSegment` make traversal structurally
impossible rather than filtered.

**Retention is checked twice, independently.** platform-api reads the learner's consent record from
Postgres. ml-inference reads the retention written *alongside the bytes* when they were stored, and
serves nothing unless it says `teacher-review` or `training-opt-in` — its stored default is
`discard`, so a chunk with no stated retention is refused. Neither check is the other's cache. If
they disagree, something is wrong and the safe answer is to refuse.

### Consequences

- Audio playback costs a platform-api round trip and holds the bytes in its memory briefly. Accepted:
  this is a review action by one member of staff at a time, not a learner-facing hot path.
- The audit log gains a row per playback. That is the point — "who listened to this child's
  recording, and when" is a question a pilot has to be able to answer.
- Withdrawal of consent takes effect at the next fetch, with no issued-credential window to expire.
- **Not yet built:** `audio_chunks` (the DB index) is still written by nothing, so no finding
  currently resolves to a stored object. The read path exists and is tested; the write path from
  realtime-gateway to platform-api is the remaining half and is a separate change.

---

## ADR-0039 — hamza-on-carrier (ؤ/ئ) ASR variance: partial credit, not full normalization

**Date:** 2026-08-08 · **Status:** Accepted (interim); full normalization pending scholar review

> Numbered 0039, not 0038: `docs/fix-adr-0019-number-collision` renumbers the interface-locale
> capability-gates ADR (a duplicate ADR-0019) to ADR-0038, so 0038 is spoken for.

**Context.** `normalizeArabic()` in `services/ml-inference/alignment.js` unifies taa marbuta (ة) with
haa (ه), since the two are acoustically similar in pause form with no tajweed significance —
verified empirically that ASR transcribing a correctly-recited taa-marbuta word as haa scored as low
as 0.75 similarity, wrongly landing in the "misread" band. A similar-shaped gap exists for hamza on a
carrier letter (ؤ hamza-on-waw, ئ hamza-on-yaa) vs the bare carrier (و, ي): also unnormalized, also
producing low scores — `similarity("مؤمن", "مومن")` = 0.75, `similarity("سئل", "سيل")` = 0.667
(adjacent to `alignWords`' `reviewThreshold`'s 0.65 missed/review boundary).

Unlike taa-marbuta/haa, hamza articulation is **itself a genuine tajweed correctness point**: hamzat
al-qat' is a real, always-pronounced glottal stop a Quran teacher corrects when dropped or
mispronounced (hamzat al-wasl is a separate, context-dependent case — silent when connected in
flowing recitation — not the bare-carrier substitution at issue here). Web research on Arabic ASR
confirms hamza is a well-documented error source in Arabic transcription — both misrecognition and
spurious insertion — but found nothing establishing the same acoustic-equivalence claim that backs
the taa-marbuta/haa normalization: an ASR writing a bare carrier for a hamza-on-carrier grapheme does
not reliably mean the reciter articulated the hamza correctly. Fully normalizing ؤ/ئ to و/ي the same
way risks the more serious opposite failure mode: scoring a genuinely dropped or mispronounced hamza
as "matched" (a false positive), in a product whose value proposition is accurate error correction.
This is exactly the kind of judgment call ADR-0014 records a precedent for routing through
`docs/SCHOLAR_REVIEW.md` and a qualified reviewer (Sheikh Hisham al-Erbili, mujawwid) rather than an
agent deciding it unilaterally.

**Decision.** Do not fully normalize. Instead, `levenshtein()` gives a hamza-on-carrier/bare-carrier
**substitution** (ؤ↔و, ئ↔ي at the same string position) partial credit — cost 0.5 instead of a full
1 — via a new `substitutionCost()` helper; `normalizeArabic()` itself is untouched. This is
deliberately narrower than full normalization:
- `similarity("مؤمن", "مومن")` moves from 0.75 → 0.875 (out of "misread", into "needs-review" —
  still surfaced for a teacher, not silently accepted as "matched").
- `similarity("سئل", "سيل")` moves from 0.667 → 0.833 (still "misread", but clear of the
  `reviewThreshold` boundary rather than sitting on it).
- Partial credit applies **only** to a same-position substitution. An outright dropped hamza (an
  insertion/deletion, e.g. `similarity("شيء", "شي")`, deleting the word-final hamza entirely) is
  unaffected — still a full-cost edit, still flagged — because that is a real, correctable
  recitation error, not an orthographic ASR ambiguity.

This mirrors the fallback already used elsewhere in this codebase when a normalization question
can't be fully resolved without a scholar: normalize only enough to stop ASR noise from tipping a
correct recitation into "misread"/"missed", while keeping the word flagged for review rather than
masking it as fully "matched".

**Consequences.** No test needing a hamza-carrier pair to score a full 1.0 match should ever be
added without a scholar sign-off recorded as its own ADR, following the ADR-0014 pattern. If a
qualified reviewer confirms hamza-on-carrier ASR variance should be scored as fully equivalent — or,
conversely, that even partial credit is inappropriate and it must score as a full penalty —
`substitutionCost()` in `services/ml-inference/alignment.js` is the single place to change, with
`alignment.test.mjs` updated to match.
---

## ADR-0040 — The ml-inference audit log grows without bound and survives erasure; retention is a human decision

**Date:** 2026-08-09 · **Status:** Proposed — needs an owner/DPO decision, NOT an engineering one
**Related:** ADR-0003 (ml-inference reached only via platform-api), the cross-learner export fix

### Context

`services/ml-inference` writes one append-only JSONL per tenant under `AUDIO_STORAGE_DIR/audit-log/`.
Three properties of it were found while fixing the learner-scoped privacy export, and none of them
can be settled by an agent:

1. **It never rotates.** Nothing truncates, ages out, or caps the file. Audio has a full
   consent-based retention sweep (`retentionTtlHours`, honouring `discard` / `teacher-review`), so
   the recording is deleted on schedule while the record *of* the recording accumulates forever.
2. **It is read whole, synchronously, on the request path.** `readTenantAuditEvents` does
   `readFileSync` + `JSON.parse` over the entire file. `GET /v1/audit-events?tenantId=` returns
   every row with no pagination or cap. On a single-threaded Node service both cost grows linearly
   and blocks every other request. platform-api's own audit endpoint — a different store, its
   Postgres `audit_events` table — is Admin/Ops-gated and already `LIMIT 200`; ml-inference's is
   behind `ML_API_KEY` and internal, so this is a reliability question, not an exposure one.
3. **Erasure does not touch it.** `deletePrivacy` removes the learner's audio and chunk metadata and
   appends `privacy.delete.requested` — an event whose `subjectId` *is* the learner's id. So a
   learner who asks to be forgotten leaves behind every audit row naming them, plus a new one
   recording the request. Their identifier is arguably more durable after erasure than before.

Point 3 is the same shape as the gap ADR-0027's lineage closed in `agent_runs`, but it is **not**
the same decision. An audit trail frequently has an independent lawful basis to persist, and
purging it can itself be the violation — destroying the evidence that a deletion was honoured. That
is a data-protection judgement about competing obligations, not a bug with an obvious fix.

### What is NOT being decided here

No retention period, no rotation scheme, and no purge-on-erasure behaviour is being introduced by
this ADR. Choosing any of them silently would be an agent inventing a compliance policy.

### The question for the owner / DPO

1. **Retention period.** How long must an ml-inference audit row be kept, and on what basis? Once
   answered, rotation is mechanical and should reuse the existing consent-retention sweep rather
   than growing a second scheduler.
2. **Erasure interaction.** On a verified erasure request, must the learner's prior audit rows be
   (a) kept intact, (b) pseudonymised — the identifier replaced, the event and its timestamp kept,
   which preserves provability while dropping the identifier, or (c) deleted outright? (b) is the
   usual reconciliation, and is a real option here because `learnerId` is now a discrete field on
   every row rather than something buried in free text.
3. ~~**Read bound.**~~ **ANSWERED — implemented.** `GET /v1/audit-events` is now bounded at 200,
   newest-first, mirroring platform-api's existing `ORDER BY created_at DESC LIMIT 200` rather than
   inventing a number, with `limit`/`offset` and `X-Total-Count`/`X-Truncated` headers so a cap can
   never be a silent one. This was always the purely-engineering part; it is settled independently
   of questions 1 and 2, which remain open.

### Urgency, corrected by evidence

This ADR originally read as though a learner's identifier were accumulating in a live system. It is
not, and the register says so plainly: **every row of `docs/readiness/SIGNOFF_REGISTER.md` is
`_PENDING_`** — including **P7.6 go/no-go**, **P7.3 bounded external pilot** and **P7.2 internal
dogfood** — there are **no release tags** in the repository, and **P5.6** records "(requires prod
infra — drill not yet run)". QrAi has never been released. No real learner has an audit row.

That lowers the urgency and raises the value of deciding now: retention is cheapest to settle before
any real data exists, not after. Questions 1 and 2 belong to the **P4.6 privacy / legal review**
signature already waiting in that register (lawyer / DPO), not to a new process — this ADR is
evidence prepared for that row, and should be read alongside `INVENTORIES.md`.

### Consequences until it is answered

The log grows unbounded for the life of a deployment, every full read of it gets linearly slower on
the event loop, and an erased learner's identifier persists in it. That is the current, honest state
— written down so it is a known open item with a named owner rather than something rediscovered
later. `learnerId` being a first-class field on each row means whichever of (a)/(b)/(c) is chosen can
be implemented without re-parsing history.

## ADR-0041 — The Flutter review queue cannot play recitation audio without a new runtime dependency

**Date:** 2026-08-11 · **Status:** Proposed — needs an owner decision, not an engineering one
**Related:** ADR-0037 (teacher audio through platform-api, every fetch audited), ADR-0022 (artifacts)

### Context

The Flutter review queue has never had an audio player. Its own comment explained why: "The web
surface fetches `/v1/recitation-sessions/{id}/audio`. That route does not exist in platform-api, so
the web player is broken. Adding a player here would need a route, a retention rule, and a
dependency."

Two of those three are now settled. `GET /v1/tajweed-findings/{id}/audio` has existed since ADR-0037
and is contracted as of 2026-08-11; the retention rule is ADR-0037's, already enforced server-side
and now surfaced in this client as a per-finding notice. What remains is the dependency.

### The blocker, stated precisely

`apps/flutter/pubspec.yaml` declares five runtime dependencies — http, flutter_secure_storage, intl,
record, web_socket_channel — and **none can play audio**. `record` captures; it does not play. No
playback package appears in `pubspec.lock`, not even transitively. Flutter has no built-in audio
playback on iOS/Android, so a package (`just_audio`, `audioplayers`, or similar) is required.

This was NOT deferred by preference. `scripts/verify.sh` runs `flutter pub get --enforce-lockfile`,
which fails when `pubspec.yaml` and `pubspec.lock` disagree, and a correct lockfile cannot be
hand-written: it carries a resolved transitive graph with per-package SHA256 hashes from pub.dev.
The environment this change was authored in has no Flutter or Dart SDK, so the lock cannot be
regenerated. Editing the manifest alone would fail the gate deterministically.

### What was delivered instead

The half that does not need the dependency, because a teacher currently gets NO indication at all:

- `TajweedFinding.audioStatus`, from the contract's `StaffTajweedFinding`.
- `audioNotice` — four distinct sentences for ADR-0037's four states, asserted distinct by test.
- No play control. A button that cannot play is the defect this same work removed from the web
  surface on the same day, where every outcome rendered as "No audio available for this session"
  and a learner's erasure was indistinguishable from a broken URL.

`available` therefore says a recording exists and that this client cannot play it yet, pointing the
reviewer at the web queue. That is a worse experience than a player and a much better one than a
control that silently does nothing.

### The decision, and why it is the owner's

Adding a runtime dependency to a mobile client is not a mechanical step here:

1. **Licence review.** `scripts/check-licenses.mjs` covers JS and Rust packages. It does not read
   `pubspec.lock` at all, so a Dart dependency enters with no licence gate — a gap this ADR names
   whichever way the decision goes.
2. **Platform surface.** Playback packages carry native iOS/Android code and background-audio
   entitlements. P6.3/P6.4 (signed builds, physical devices) are already `_PENDING_`, and this
   enlarges what those signatures cover.
3. **What is actually played.** ml-inference stores whatever the gateway captured. The web client
   guesses `audio/webm` at the Blob; a native player needs a real container, and nothing yet
   asserts what those bytes are. That question should be answered before a player ships, not after.

### Options

| | |
|---|---|
| **A** | Add `just_audio`, regenerate the lock on a machine with the SDK, extend the licence gate to Dart, and answer (3). Full parity with the web queue. |
| **B** | Leave the notice as shipped. A reviewer who must listen uses the web queue. Costs nothing and hides nothing. |
| **C** | Ship a player only after P6.3/P6.4, so the native surface is signed off once rather than twice. |

Recommended: **B until a mobile owner exists, then A or C.** No reviewer is blocked today — the web
queue plays audio and the notice says where to go. The dependency should land with the person who
will sign the build that carries it.

## ADR-0042 — Does blocking a model retract a human's approval of one finding?

**Date:** 2026-08-12 · **Status:** Proposed — needs a scholar/product ruling, not an engineering one
**Related:** ADR-0028 (the learner gate), P3.2 (withheld-feedback tests), P3.6 (scholar approval)

### Context

P3.2 asks for withheld-feedback and provenance tests covering findings that are **missing**,
**rejected**, **expired**, or **fixture** data. Three of the four are covered with failing-first
tests and now have a guard that keeps them covered
(`tests/contract/withheld-reasons.test.mjs`, plus `fixture`).

**`expired` has no meaning in this system, and cannot be given one by an engineer.**

Measured, 2026-08-12:

- No table has an expiry column for an approval. Every `expires_at` in the schema —
  `pilot_invitations.expires_at`, `pilot_sessions.idle_expires_at`,
  `pilot_sessions.absolute_expires_at`, `realtime_session_tickets.expires_at` — is an
  authentication lifetime. None of them concerns a human's judgement.
- `tajweed_findings` records `review_status` and nothing about *when* the review happened or how
  long it holds.
- The column an engineer would reach for, `model_versions.status`, is **read by no service at all**
  (grep across `services/`, and 0027 says so in a comment). Its live values today are `draft` and
  `eval-passed`; `blocked` is a value nothing acts on.

So the honest state is stronger than "expiry is untested": there is no mechanism by which any
approval is ever reconsidered, and the field that looks like one is inert.

### The question

A teacher approved finding *F*, produced by model version *M*. Later *M* is found to be wrong —
blocked, or superseded by a retrained model. **Is the teacher's approval of *F* still valid?**

Both answers are defensible, and the difference is visible to a learner mid-session:

| | if approval survives | if approval is retracted |
|---|---|---|
| what the teacher approved | *this finding, about this recitation* — a judgement they made by listening, which a later model has no bearing on | *the model's output*, which they endorsed on the assumption the model was sound |
| what a learner sees | the note stays; their memorization is not disturbed | the note disappears, possibly between one screen and the next, with no explanation they can act on |
| the failure it allows | a learner keeps studying from feedback derived from a model the project has disowned | a learner's reviewed, correct feedback is withdrawn because an unrelated model version was retired |

There is a **precedent inside this repo** for the second answer. The locale work already decided a
human review has a shelf life: `LocaleCapability.interface.reviewExpiresAt` is enforced in
`apps/web/src/data/platform.ts:147`, and a Sorani pack whose review has lapsed stops being offered.
Nobody argued a reviewer's judgement was eternal there. Whether recitation feedback is the same kind
of claim is exactly what needs deciding.

### Why this is not an engineering default

Picking either answer silently would be the worse outcome. "Approval survives" is the current
behaviour by omission, not by decision — nobody chose it, and it is indistinguishable from having
forgotten the question. "Approval is retracted" changes what a learner sees without telling them
why, which is the failure ADR-0041 names: a status that collapses distinct outcomes into one
message is worse than its absence.

It also cannot be tested before it is decided. A test asserting either behaviour would be an
engineer's ruling on a scholarly question, wearing a test's authority.

### Decision

**Deferred.** P3.2 stays open with this as its single named blocker, rather than being ticked on
three-quarters coverage or left vaguely incomplete.

What is in place meanwhile:

- `tests/contract/withheld-reasons.test.mjs` derives the withheld reasons from the contract and
  requires a test for each, so the three covered reasons cannot silently regress and `expired`
  cannot silently be forgotten — it is listed as deliberately absent, with this ADR as its reason.
- Nothing has been built that pretends to expire. There is no dormant column, no unused flag, and
  no UI string about staleness. When the ruling comes, it lands on a clean surface.

### What a decision needs to specify

1. Does a blocked or superseded model retract prior approvals of its findings — always, never, or
   only when the model was blocked for a correctness reason rather than retired for a routine one?
2. If approvals are retracted, what does the learner see in place of a note that was there
   yesterday? "This note was withdrawn pending re-review" is honest; silence is not.
3. Do approvals expire on a clock as well, as locale reviews do — and if so, does an expired
   approval withhold the finding or merely flag it for re-review?

## ADR-0043 — Signed release evidence: the architecture that shipped, and the retention nobody chose

**Date:** 2026-08-12 · **Status:** Proposed — the architecture is describing what exists; the
retention policy needs an owner's approval
**Related:** P0.2 (this ADR), P0.4 (manifest + verifier), P7.4 (fresh bundle), P7.5 (challenger),
ADR-0022 (artifacts), `docs/RELEASE_SIGNING.md` (store signing, a different problem)

### Context

P0.2 asks for an approved ADR covering signed release-evidence architecture and retention. It has sat
open while **the architecture was built anyway**: `scripts/release-manifest.mjs` (schemaVersion
2.1.0) and its 22 adversarial tests bind every item P0.4 names, and P0.4's own ledger note records
the engineering as complete.

That ordering is the problem this ADR fixes. A design that exists only as code is a design nobody
approved, cannot review as a whole, and cannot disagree with — the next person meets it as a fact
rather than a choice. So the first half below is **descriptive**: it records decisions already made,
so they can be challenged. Only the retention half is genuinely open.

`docs/RELEASE_SIGNING.md` is a different subject: it covers signing an APK so a store will accept it.
This is about signing the *evidence* that a candidate is what it claims to be.

### The architecture, as built

- **Ed25519, and only Ed25519.** Enforced on the private key, the signature algorithm, and every
  public key in the trusted-signer policy. Not negotiable at runtime: an RSA key is refused at
  generation, not at verification.
- **A trusted-signer policy, separate from the signature.** A valid signature by an unauthorized key
  is refused, and the policy itself is hashed into the signed content — so swapping the policy after
  the fact invalidates the manifest rather than authorizing a new signer retroactively.
- **The candidate is a clean Git checkout, asserted.** Untracked files, modified tracked files, and a
  manifest generated from an earlier commit are each refused. Evidence about a working tree nobody
  can reconstruct is not evidence.
- **Nine bound facts** — source, build, image, SBOM, smoke, test, environment, signature, expiry —
  each with an adversarial test for the case where it drifts. The list is P0.4's; this ADR records
  that binding them *together in one signed object* was the decision, because any one of them alone
  can be true of a different build.
- **Expiry is mandatory and must be in the future.** There is no unbounded evidence. This is the
  decision most worth stating out loud, because its consequence is that a release candidate goes
  stale on a clock whether or not anyone is watching — which is the intent.

### The open half: retention

**Nothing in this repository says how long a signed bundle is kept, or what happens to it after
expiry.** Grepped across `scripts/release-manifest.mjs` and `docs/RELEASE_SIGNING.md`: the word does
not appear. Expiry is enforced; retention is undefined. Those are different questions, and having
one without the other is what makes this ADR Proposed rather than Accepted:

- An expired manifest is refused by the verifier. It is not deleted, and nothing says it should be.
- So today's de-facto policy is "keep everything forever, and refuse to act on the old ones" — which
  may well be right, but was chosen by nobody.

Retention is not an engineering preference. It interacts with:

1. **Incident forensics.** After a bad release, the question is what the candidate contained. That
   needs the bundle for the *previous* releases too, not only the current one.
2. **Privacy.** A bundle binds an environment summary and a smoke trace. If any future evidence
   captures learner-derived data — it does not today, and it must not start without revisiting this
   — an indefinite retention becomes a data-protection question rather than a storage one.
3. **The challenger's job (P7.5).** An independent verifier needs enough history to compare a
   candidate against its predecessor. Too short a window makes that impossible.

### Decision

**The architecture above is recorded as-is and is not changed by this ADR.** It is already enforced
by 22 tests; re-deciding it now would be theatre.

**Retention is deferred to an owner**, with a recommendation to make explicit rather than inherit:

| | proposal |
|---|---|
| **Keep** | every signed bundle for a released candidate, indefinitely — they are small, and they are the only record of what shipped |
| **Prune** | unreleased candidate bundles after 90 days, since a candidate that never shipped has no forensic claim on the future |
| **Never delete on expiry** | an expired bundle is refused for *acting on*, and kept for *explaining* — those are different uses and only one of them has a clock |
| **Revisit if** | evidence ever begins capturing learner-derived content, which would move this from a storage decision to a privacy one |

### Consequences

- P0.2 stays open until an owner approves. The row's blocker is now one specific question —
  retention — rather than "an ADR is missing", and the architecture half is no longer unwritten.
- P0.4 is unaffected: its engineering was already complete, and its blocker is a retained
  candidate-bound artifact, which is P7.4's job.
- Nothing was built to satisfy this ADR. No retention field, no pruning script, no dormant config.
  When the ruling comes it lands on a clean surface — the same discipline as ADR-0042.

## ADR-0044 — `server/` is the Node backend; `services/node-api` is frozen

**Date:** 2026-08-12 · **Status:** Accepted (engineering scope only — see Non-scope)
**Related:** ADR-0034 (a port is only ported where something compares it), PR #388,
`specs/lean-flutter-node-consolidation/tasks.md`

### Context

Two Node backends exist in this repository at once:

| | `services/node-api` (main) | `server/` (PR #388, unmerged) |
|---|---|---|
| route modules | 14 | 16 — the same 14, plus `canary`, `device-identity` |
| `routes/review.mjs` | 536 lines | 773 lines, the same file grown |
| cutover control | `NODE_API_PORTED`, default none | `NODE_API_PORTED` + `NODE_API_ROUTE_MODE=retained-canary` |
| driven by the A/B parity harness | yes | yes — `startShell` spawns `server/src/main.mjs` |
| Rust oracle retained | yes | yes |
| also contains | — | `jobs/`, `storage/`, `realtime/`, `inference/`, `identity/`, `worker.mjs` |

Measured 2026-08-12. These are **not rival designs**. `server/` is `services/node-api` at a later
age: same lineage file by file, same strangler control, same parity harness, same Rust oracle. It
additionally absorbs `services/ml-inference` (as `inference/` + `storage/`) and
`services/realtime-gateway` (as `realtime/`), which is why PR #388 deletes both.

Leaving the question open is the expensive option. Two ledgers are counting progress against two
codebases: `specs/readiness-recovery-10-10` (on main, 36 open rows) and
`specs/lean-flutter-node-consolidation` (on the draft, 40 open rows, not on main). Work landing on
one is invisible to the other, and every W2/W3/W6/W7 task inherits an answer nobody has given.

### Decision

**`server/` is the Node backend this project is building.** `services/node-api` is its earlier form
and is **frozen**: it may be fixed, but it may not grow.

Concretely, frozen means:

- **No new route modules, no new route keys in `PORTABLE`, no new `lib/` modules.** A new capability
  belongs in `server/`. Adding it here would mean implementing it twice and proving it once.
- **Fixes are allowed and expected.** A freeze that forbids repair would push people to work around
  it. Bug fixes, test additions, and security corrections to existing modules stay in scope.
- **Shrinking is allowed.** Removing a module is retirement, which is the direction of travel.

Enforced by `tests/contract/node-api-frozen.test.mjs`, pinned to 14 route modules, 9 lib modules and
37 `PORTABLE` keys. The pin IS the decision here rather than a measurement of it — the guard's whole
content is "this set does not grow", and it names `server/` in its failure message so the next
person is told where the code goes instead.

### Why `server/` rather than `services/node-api`

Keeping `services/node-api` would mean re-doing the consolidation it already contains — durable
jobs, the audio object store, the realtime boundary, local inference, the canary route. That is the
bulk of PR #388's 96 commits, and redoing it would buy nothing: the draft did not abandon the
discipline that makes a port trustworthy, it inherited it. `PARITY_THROUGH_SHELL` still puts it
behind the same A/B differ, and `scripts/verify.sh` on that branch still runs the Rust suite as the
oracle.

### Two risks this decision creates, and how each is closed

**1. The controls now exist twice, independently.** Rate limiting, `MAINTENANCE_MODE`, the
superuser/BYPASSRLS refusal, the `x-forwarded-for` overwrite, `UPSTREAM_TIMEOUT_SECS` and trace
propagation are present in BOTH trees — but main's are proven by parity tests written against
`services/node-api`, and `server/`'s are separate code those tests have never run against. Two
implementations of a security control agreeing by assumption is the exact shape this repo keeps
finding defects in.

*Closed by:* `tests/api-parity/lib/harness.mjs:451` spawns the shell, and it is one line. Pointing it
at `server/src/main.mjs` runs the whole A/B suite, the five journeys and the fault tests against the
survivor. Every divergence surfaces there. **This must pass before `services/node-api` is deleted.**

**2. `services/ml-inference` cannot be deleted in the same change.** Four of the five journeys in
`docs/readiness/JOURNEYS.md` spawn `services/ml-inference/server.mjs` directly, and it owns
`audio-storage/` and the on-disk erasure that ADR-0037 and the privacy journey prove. That
`server/inference/` and `server/storage/` replace it faithfully is currently asserted, not shown.

*Closed by:* keeping `ml-inference` and `realtime-gateway` until the journeys pass against
`server/`'s absorbed versions, as a separate step with its own evidence.

### Sequence

1. This ADR; the freeze guard. (Here.)
2. Rebase PR #388 onto main — 21 commits behind, 23 conflicting files, mostly `verify.sh` test-list
   unions and `DECISIONS.md` appends.
3. Flip `harness.mjs:451` to `server/src/main.mjs`; run the full gate. Reconcile every divergence.
4. Delete `services/node-api`.
5. Separately, and only once the journeys pass against it: retire `ml-inference` and
   `realtime-gateway`.

A 631-file draft cannot be reviewed. Steps 2–4 should land along the seams `server/` already has —
`lib/` + routes first (the direct successor), then `jobs/` + `storage/`, then `inference/`, then
`realtime/` — so there is no window in which main has no working backend.

### Non-scope

This decides which codebase the Node backend lives in. It does **not** authorize a production
cutover: `NODE_API_PORTED` still defaults to none in both trees, and ADR-0034's rule stands —
a route is servable only where something compares it. Turning routes on in production remains an
owner decision with canary and rollback evidence, which is W2/W3/W6, not this.

It also says nothing about whether the product is ready. P3.4/P3.5 — no held-out evaluation — is
untouched by which process serves the routes.

## ADR-0045 — A right-to-erasure request does not delete the account

**Date:** 2026-08-12 · **Status:** Proposed — needs a DPO/product ruling, not an engineering default
**Related:** ADR-0040 (the ml-inference audit log survives erasure), `docs/DATA_INVENTORY.md` §2/§4,
`specs/privacy-delete-learner-scope`, the `privacy-erasure` journey

### Context

`docs/DATA_INVENTORY.md` maintains two lists in one file: §2 enumerates the personal-data
categories, and §4 describes what `POST /v1/privacy/delete` removes. **Account** is the first row of
§2 — `id`, `tenant_id`, `display_name`, optional `email`, `password_hash`, `role`, `language` — and
appears nowhere in §4.

Reproduced against a live erasure on 2026-08-12, with ml-inference running so the request actually
succeeded (`200`, not the fail-closed `502` you get when the audio service is down):

```
BEFORE: {"display_name":"Erasure Probe Learner","email":"…@example.test","has_pw":true}
delete status: 200
AFTER : {"display_name":"Erasure Probe Learner","email":"…@example.test","has_pw":true}
```

Byte-identical. A learner who exercises their right to erasure has their recitations, alignments,
findings, progress, consent records, tickets, pilot sessions, agent runs and raw audio removed — and
their **name, email address and password hash remain**.

The code and the documentation agree with each other. Neither addresses the account.

### The question

**Does "delete my data" mean "delete my account"?** Three defensible answers, and the difference is
what a data-protection authority would be told:

| | what happens | what it costs |
|---|---|---|
| **Delete the row** | the learner ceases to exist in the database | breaks `privacy_jobs.learner_id REFERENCES users(id)` — the erasure receipt loses its subject, so the proof the request was honoured is damaged by honouring it |
| **Scrub, keep the id** | `display_name` and `email` replaced, `password_hash` cleared, row survives as a tombstone | the receipt keeps its FK; needs a decision on what a scrubbed name reads as, and whether the tenant/role/language fields are also personal |
| **Keep it, as today** | erasure covers the learner's *content*, not their *account* | defensible only if erasure and account-closure are genuinely separate rights, and it must then be **said** — currently the product implies one and delivers the other |

The middle option is the obvious engineering answer, which is exactly why an engineer should not
pick it unilaterally: "what does a scrubbed learner look like to a teacher who reviewed them last
week" is a product question, and "is a pseudonymised tombstone erasure" is a legal one.

### Why this was not visible

Nothing compared the two lists. §2 and §4 are prose, maintained by hand, in the same document —
which is exactly the arrangement that makes a gap invisible: a reader checking §4 finds an
impressively thorough cascade and never re-reads §2 to notice which category is missing from it.

The `privacy-erasure` journey test walks the request end to end and asserts both halves that were
known to matter — derived rows in Postgres, raw audio on ml-inference's disk. It does not assert
anything about `users`, because nobody had asked.

### Decision

**Deferred.** No scrubbing, no deletion, no dormant column, no "anonymised" placeholder — the same
discipline as ADR-0042 and ADR-0043. Building the mechanism first would make the ruling look
already-made.

What lands instead is the check that makes this the last silent instance:
`tests/security/erasure-coverage.test.mjs` derives every foreign key into `users(id)` **from the
live schema** and requires each to be either deleted by the cascade — read from the handler's own
source — or declared with a reason. A new table that can identify a person cannot be added without
a recorded position on erasing it.

Three references are declared **retained** or **staff-only** and are correct as they stand:
`audit_events.actor_id` and `privacy_jobs.learner_id` are the record that the erasure happened, and
`scholar_approvals.reviewer_id` / `teacher_reviews.teacher_id` hold a staff actor rather than the
subject. `users.id` is declared retained pointing at this ADR, and that declaration fails the moment
this ADR stops being Proposed.

### What a ruling needs to specify

1. Delete, scrub, or keep — and if scrub, which columns, and what the replacement value reads as to
   a teacher looking at their own past reviews.
2. Whether account closure is a separate request with its own endpoint, or the same one.
3. Whether the erasure receipt may name a person who no longer exists — i.e. whether
   `privacy_jobs.learner_id` should become a free-standing identifier rather than an FK.

## ADR-0046 — `recordingConsent` is a checkbox no server reads

**Date:** 2026-08-12 · **Status:** Proposed — the remediation needs a data decision, not just a gate
**Related:** ADR-0028 (the learner gate is enforced on the wire, not in the client),
`docs/DATA_INVENTORY.md` §5, `packages/contracts` `ConsentSnapshot`

### Context

The consent panel offers five choices. Three are enforced server-side and one is not enforced
anywhere:

| flag | what the learner is told | server-side gate |
|---|---|---|
| `audioRetention` | "otherwise it is discarded after analysis" | `mustDiscardAudio`, ml-inference:1089 |
| `externalAsrProcessing` | "Allow browser or cloud speech processing…" | `canUseExternalAsr`, recitation.rs:160 |
| `guardianApproved` | "required for learners under 13" | same gate |
| **`recordingConsent`** | **"(Required to record.)"** | **none** |
| **`anonymizedLearning`** | **"Help improve the model with anonymized data."** | **none — nothing reads it at all** |

Reproduced 2026-08-12 against a running service:

```
session create with recordingConsent=false -> 200
realtime ticket for that session          -> 200  TICKET ISSUED (audio streaming authorised)
stored consent snapshot recordingConsent  =  false
```

The session's own stored answer says the learner does not consent to being recorded, and the ticket
that authorises audio streaming is issued anyway. `docs/DATA_INVENTORY.md` §5 states the enforcement
honestly — "enforced on web + mobile" — which is precisely the arrangement ADR-0028 was written
after: *a display choice, not an authorization boundary*.

### Why it is unenforced: the field has no column

`consent_records` stores `audio_retention`, `anonymized_learning`, `external_asr_processing`,
`guardian_approved`, `consent_version`. There is **no `recording_consent` column**. The flag exists
in the contract, in the UI and in `recitation_sessions.consent_snapshot` (JSONB) — and not in the
table every server-side gate joins. The ticket mint reads `c.audio_retention` and
`s.external_processing_allowed` from exactly that join, so it could not consult recording consent
even if someone had thought to.

### Why this is not a one-line fix

Refusing a ticket when the snapshot says `false` would be the obvious change, and it would be wrong
today:

```
recordingConsent = false    4615 sessions
recordingConsent = true     3403 sessions
absent                      1157 sessions
```

`false` is also the **default** — `sessions.mjs:50`, `recitation.rs:370` — so for most of those
4,615 rows it means "never populated", not "the learner declined". The two are indistinguishable in
the data. A strict gate would deny the majority of existing sessions and read, to an operator, as an
outage.

### Severity, stated honestly

Lower than it first appears, and still real. The audio a learner can cause to be captured this way
is **their own**: nothing here lets one person record another, and the real web client blocks the
flow before it starts. What the system does have is a stored recording of a person alongside that
person's own recorded refusal — a records and lawful-basis problem, not an attacker capturing a
minor's voice. It would matter to a DPA and it does not warrant an incident.

`anonymizedLearning` is currently harmless for a different reason: **no training pipeline exists**
(P3.4/P3.5), so no data is used for learning whether the box is ticked or not. That is exactly why
it could stay broken indefinitely — and why nothing would stop a future pipeline from ignoring it.

### Decision

**Deferred**, and nothing is enforced in this change. Turning the gate on requires deciding:

1. **What the 4,615 `false` rows mean.** Backfill from another signal, treat historical rows as
   grandfathered, or migrate and re-ask? Choosing wrong either denies consenting learners or
   ratifies consent nobody gave.
2. **Where the boundary is.** The ticket is the honest place — recitation.rs:464 already says "the
   ticket is the only channel it has" — but session creation and chunk storage are also candidates,
   and picking one means the others must be provably unreachable without it.
3. **Whether `recording_consent` becomes a column.** Reading JSONB works; a column is what every
   other enforced flag has, and the absence of one is why this was invisible.
4. **What `anonymizedLearning` is for.** If it will gate a future training pipeline, say so and
   write the gate when the pipeline exists. If it will not, the checkbox should go — a control that
   cannot act is worse than its absence (ADR-0041).

Meanwhile `tests/security/consent-gate-coverage.test.mjs` requires every flag in the contract to
have a named server-side gate or a declared reason, so a sixth flag cannot be added and quietly do
nothing, and neither of these two can be forgotten.

## ADR-0047 — the realtime ticket cannot be revoked, and the erasure deletes its record anyway

**Date:** 2026-08-12 · **Status:** Proposed — the fix is an architectural choice, not a one-liner
**Related:** ADR-0041 (a control that cannot act is worse than its absence), ADR-0045 (erasure does
not delete the account), `infra/sql/0021_pilot_identity.sql`

### Context

Every other token this system mints is looked up before it is trusted:

| token | stored as | looked up by | revocable |
|---|---|---|---|
| pilot session cookie | `pilot_sessions.token_hash` | `app.get_pilot_session_by_hash` (`auth.rs:171`) | yes — `revoked_at` |
| pilot invitation | `pilot_invitations.token_hash` | `app.consume_pilot_invitation_by_hash` (`pilot.rs:46`) | yes — single-use |
| **realtime ticket** | **`realtime_session_tickets.token_hash`** | **nothing** | **no** |

The realtime ticket is a stateless HMAC with a 300s TTL. `platform-api` computes its SHA-256 and
writes the row (`recitation.rs:514`); `realtime-gateway` validates the signature and never opens a
database connection at all — it has no `sqlx` dependency. The stored `token_hash` is read by no
code path in either service. It is written, counted by the privacy export, deleted by the erasure,
and never consulted.

### What that costs: the erasure can be raced

`privacy.rs:452` runs `DELETE FROM realtime_session_tickets WHERE tenant_id = $1 AND learner_id = $2`.
It reads as revocation. It revokes nothing, because nothing was ever going to read those rows.

Reproduced 2026-08-12 against a real gateway and a real ml-inference, two tickets minted before any
erasure request:

```
1. chunk streamed BEFORE erasure   -> accepted: true
   files on disk: 2
2. erasure (POST /v1/privacy/delete, the call platform-api makes) -> 200
   files on disk after erasure: 0
3. chunk streamed AFTER erasure    -> accepted: true
   files on disk after: 2   session-erasure-race-ws-0001.bin
                             session-erasure-race-ws-0001.meta.json
```

The erasure completed, reported success, and the learner's audio was written again afterwards by a
ticket the erasure believed it had destroyed.

### Severity, stated honestly

Bounded, and still worth fixing.

- The window is at most the ticket's remaining TTL — 300 seconds — and only for a ticket already
  minted. It is not a way to obtain new access.
- It is the learner's **own** audio and their own ticket. Nothing here lets one person record
  another, and a real client stops streaming when the learner leaves the page.
- A second erasure request would collect the orphan: ml-inference deletes by tenant/learner
  directory, not by database lookup. But the learner has no reason to ask twice — they hold a
  receipt saying it is done.
- The orphan is invisible to the database: `index_audio_chunk` would 404 on the deleted session, so
  no `audio_chunks` row exists for it. Its lifetime is then decided only by the on-disk
  `.meta.json`, and for `audioRetention: "training-opt-in"` the eviction sweep `continue`s — it is
  **never** deleted (`server.mjs:1738`).

So: a bounded race that leaves audio the learner asked to be destroyed, potentially permanently, and
a receipt that already said otherwise.

### Why there is no obvious fix to just apply

1. **Make the gateway check the database.** It deliberately holds no connection; giving it one puts
   Postgres on the realtime audio path and changes its failure model.
2. **Publish revocations to Redis**, which the gateway already reaches for dedup and active-session
   counting. Architecturally the closest fit — and Redis there is explicitly *best-effort*
   (a stalled Redis must not block chunk acceptance; that was a deliberate fix). A revocation check
   on a best-effort dependency is a control that silently does not act, which is the thing ADR-0041
   is about.
3. **Shorten the TTL.** Reduces the window without closing it, and costs re-mints on every
   reconnect.
4. **Re-run the ML audio erase after the ticket TTL expires.** Closes it exactly, and needs a
   deferred-job mechanism this system does not have.

Each trades a different thing. Picking one is a decision about the realtime path's dependencies, not
a bug fix.

### Decision

**Deferred.** Nothing is changed here. `tests/security/token-revocability.test.mjs` requires every
token-bearing column in the schema to be either looked up before it is trusted — naming the file and
the lookup — or declared stateless with a reason, so the next unrevocable token cannot be minted
silently, and so `realtime_session_tickets.token_hash` cannot keep reading as a revocation record
without this ADR attached to it.

# Architecture Decision Records

Short ADRs. Add one whenever you introduce a new runtime dependency or make an
architectural change. Newest first.

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

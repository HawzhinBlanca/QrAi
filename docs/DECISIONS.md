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

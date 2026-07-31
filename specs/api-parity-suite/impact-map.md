# Impact map — Phase 6: cross-language API parity suite

Scope of the change under `plan.md` recommendation **B**. Under **A** the file list is identical;
only the number of test cases inside `default.test.mjs` grows.

---

## 1. New files — no existing callers, so nothing can break

| path | what |
|---|---|
| `tests/api-parity/lib/harness.mjs` | `startApi` / `request` / `queryJson` / `startMockUpstream` |
| `tests/api-parity/lib/harness.test.mjs` | P1 — tests for the harness itself |
| `tests/api-parity/default.test.mjs` | P2 — 17 tests, default config |
| `tests/api-parity/auth-disabled.test.mjs` | P3 — `ALLOW_HEADER_AUTH=0` |
| `tests/api-parity/ml-proxy.test.mjs` | P3 — mock ML/ASR upstream |
| `tests/api-parity/cors.test.mjs` | P3 — `CORS_ALLOWED_ORIGINS` |
| `tests/api-parity/metrics.test.mjs` | P3 — `METRICS_TOKEN` / dev-open / closed |
| `tests/api-parity/coverage.json` | P6 — the ported / deferred / remainder ledger |
| `tests/api-parity/coverage.test.mjs` | P6 — asserts it matches `integration.rs` |
| `scripts/verify-parity-teeth.sh` | P4 — the must-fail mutation runner |
| `specs/api-parity-suite/evidence/` | P4 output, committed |

`tests/` does not exist at the repo root today (verified) — no collision. It is deliberately **not**
`scripts/`: these files are a language-independent contract suite, not tooling.

## 2. Modified files — every one has real callers

### `scripts/verify.sh` (line 121, the explicit `node --test` path list)

**Callers: everything.** `.github/workflows/ci.yml`, the `.claude/settings.json` PostToolUse
(`--fast`) and Stop (full) hooks, `AGENTS.md:24`, `README.md:70`, `specs/constitution.md:23`.

- The `--fast` path (lint + typecheck) is **unaffected** — the test block is inside
  `if [[ "$FAST" != "yes" ]]`, so the PostToolUse hook does not get slower.
- The full path gains one step. Appending to the existing explicit-path list preserves the
  documented reason for not globbing (`verify.sh:118-120`: a directory glob also matches non-test
  `.mjs` files).
- **Risk:** this suite needs a live Postgres *and* a built binary, unlike every other entry on that
  line. It therefore does **not** belong on line 121 — it belongs in the DB-gated block at
  `verify.sh:146-177`, next to `test: platform-api integration (live Postgres)`, which already has
  the skip-when-no-DB / fail-on-`--release` logic this suite needs. Adding it to line 121 would make
  `verify.sh` fail on every machine without Postgres.

### `.github/workflows/ci.yml`

**Caller: the required status check on every PR.** Needs a step that builds the platform-api binary
and makes it findable by `startApi`. The `postgres:16-alpine` service, all `infra/sql` migrations,
and `rls-app-role.sql` are already applied (`ci.yml:10-12,88,91`) — no new service.

Added CI wall-clock is process startup, not compilation: `cargo test --manifest-path $API` already
builds the crate.

### `package.json` (only if the approver picks `pg`)

One `devDependencies` entry. Interacts with two existing gates:

- `pnpm audit` — a new package enters the supply-chain gate that went red repo-wide on
  GHSA-r28c-9q8g-f849 (see MIG5's record). `pg` is a mainstream, low-churn package; still, this is a
  real new surface, not a free one.
- `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` — a freshly published version may be held back
  by the minimum-release-age policy. Pin a version already past it.

### `docs/DECISIONS.md`

ADR-0023 (driver choice). AGENTS.md requires an ADR for a new dependency. Note ADR-0022 (rollback
artifact) is still **Proposed** and unrelated — this does not resolve it.

### `AGENTS.md` / `README.md`

Only if the gate command list changes shape. Appending a step inside `verify.sh` does not change
`bash scripts/verify.sh` as the documented entry point, so **no edit is expected**. Flagged because
`AGENTS.md` is the declared single source of truth for gate commands, and a divergence there is the
exact drift it exists to prevent.

## 3. Read but not modified — the coupling P6 makes explicit

`services/platform-api/tests/integration.rs` is **parsed** by `coverage.test.mjs` to enumerate the 77
`#[test]` functions. Nothing parses it today (verified: no references in `scripts/` or `.github/`).

This creates a new, deliberate coupling: **adding a Rust integration test will fail
`coverage.test.mjs` until it is classified.** That is the intent — it is what stops the parity suite
drifting silently out of date. It is also a new way to break the gate with an unrelated change, so it
must be documented at the top of `coverage.json` with the one-line fix (add an entry).

The parser matches `#[tokio::test]` / `#[test]` followed by an optional attribute block then
`fn <name>`. If someone adds a test using a different macro, the parser under-counts silently. P6's
acceptance therefore requires temporarily adding a test and watching it go red — measured, not
assumed.

## 4. Symbols reused rather than rewritten

| existing | reused for |
|---|---|
| `scripts/smoke-api.mjs:11-30` `request()` | the dev-header identity request shape (`x-tenant-id` / `x-user-id` / `x-user-role`) |
| `scripts/smoke-sql.mjs:414` `PSQL` override | precedent for locating an external binary, if the approver picks `psql` |
| `verify.sh:146-177` DB-reachability probe | the skip-when-no-Postgres logic — copied in spirit, not duplicated |

`scripts/smoke-*.mjs` themselves are **not modified**. They are `process.exit(1)` scripts serving the
release smoke path (`verify.sh:188`, `pnpm smoke:all`); converting them is out of scope and would put
the release gate at risk for no gain here.

## 5. Not touched

`services/platform-api/src/**` — no production code changes. If a ported test disagrees with the Rust
service, the finding is **recorded**, not fixed by editing the service: that is a separate,
visible decision, the same rule Phase 5 applied to the four API facts it recorded (200-not-201,
403-not-401, snake_case, 500-on-bad-FK).

`services/platform-api/tests/integration.rs` — not edited, not deleted, keeps running in CI.

## 6. Guarded paths

`scripts/verify.sh` and `.github/workflows/ci.yml` are gate-defining files behind the CODYSTEM
PreToolUse guard (`/Users/hawzhin/Codystem/.claude/settings.json:5-8` →
`scripts/guard-pretooluse.sh`). The `.codystem-allow-self-edit` sentinel is **absent** right now
(checked). MIG5 modified both successfully, so the path is known and workable — but the edit is
expected to require the sentinel, and that is an approver-visible action, not something to route
around.

## 7. Blast radius if this goes wrong

| failure | who notices | contained by |
|---|---|---|
| Flaky server startup | every PR — CI red on unrelated changes | ephemeral ports, `/health` polling with timeout, P3's port-closed assertion |
| Suite added to the wrong `verify.sh` block | every developer without Postgres — gate fails locally | §2's placement rule: DB-gated block, not line 121 |
| Orphaned server processes | slow accumulation, then port exhaustion | `after()` hook reaps; P1 tests that `stop()` actually kills the child |
| Transcription weakened an assertion | **nobody — this is the silent one** | P4's teeth check is the only thing that catches it |

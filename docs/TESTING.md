# Testing

## The gate
`bash scripts/verify.sh` is the single source of "does it work". It runs:

1. **guard** — fails if any secret/protected file (`.env`, `secrets/`, `*.pem`) is tracked.
2. **lint** — `cargo fmt --check` + `cargo clippy -D warnings` for both Rust services.
   (TS has no separate linter; type safety is the TS lint, run next.)
3. **typecheck** — `tsc` for `@quran-ai/contracts`, `@quran-ai/quran-data`, `@quran-ai/web`.
4. **test** — vitest for the three TS packages; `node --test` for the Node services
   (`ml-inference/alignment.test.mjs`, `ml-inference/tajweed.test.mjs`,
   `ml-inference/server.test.mjs`, `agents/agents.test.mjs`, run by explicit path
   because a dir glob would import the listening `server.mjs`); `cargo test` for both
   Rust services. `ml-inference/golden-regression.test.mjs` (live-computed alignment/
   tajweed metrics against the real canonical Quran data) is NOT in this list yet — it's
   wired into `scripts/proof.sh` but adding it to `verify.sh` needs an edit to that
   CI-protected file; tracked as an open follow-up.
5. **build** — `pnpm build` (contracts + quran-data + web).

`bash scripts/verify.sh --fast` runs only lint + typecheck (used by the PostToolUse hook).

> **verify.sh vs `pnpm test` / `pnpm proof`.** The two legacy commands run the platform-api
> integration tests with `--include-ignored` *unconditionally*, so they **fail** without a
> live Postgres. `verify.sh` is the gate that **skips** those tests when no DB is reachable
> (it never fakes them) — this matters for a local run with no Postgres started, not for CI:
> `.github/workflows/ci.yml` runs a real `postgres:16-alpine` service container and applies the
> full migration list before `verify.sh` runs, so the DB-gated tests DO execute (and are asserted)
> in CI, same as a local run with Postgres up.
> `scripts/proof.sh` (`pnpm proof`, also what `scripts/smoke-all.mjs`'s first step runs) covers
> more test suites than it used to: it now also runs `apps/mobile`'s and
> `services/ml-inference`/`services/agents`' `node:test` suites directly by path (none of the
> three are pnpm workspace members, so none are reachable via `pnpm --filter`).
> `ml-inference`/`agents` were already covered this way in `verify.sh` (see step 4 above);
> `apps/mobile` is not yet — its regression coverage currently only runs via `pnpm proof`.

## Database-gated tests (platform-api)
`services/platform-api/tests/integration.rs` has tests marked
`#[ignore = "requires live Postgres"]`. The gate runs the infra-free tests always and runs
the ignored ones **only** when a live Postgres answers at `$DATABASE_URL` — otherwise it
prints a SKIP line. They are never faked. To include them:

```bash
docker compose up -d postgres          # postgres:16-alpine on :5432, schema auto-loaded
bash scripts/verify.sh                 # now runs `cargo test ... -- --include-ignored`
# or point at any DB:
DATABASE_URL=postgresql://user@host:5432/db bash scripts/verify.sh
```

> **`cargo-mutants` against DB-touching code can leave garbage rows in a real local Postgres.**
> Mutation testing recompiles the source with one line mutated, then runs the *actual* integration
> test suite against `$DATABASE_URL` for real (not a mocked/rolled-back transaction) — that's the
> whole point, it needs to observe real behavior to know if a test catches the mutation. When a
> mutant disables input validation (e.g. `create_agent_run`'s reviewStatus/status allowlist check),
> a test asserting "invalid input is rejected with 400" still correctly marks that mutant CAUGHT
> (the assertion on the HTTP response fails), but the invalid row the mutated code accepted along
> the way is never rolled back or cleaned up — it's a real commit to a real table. Symptom: `pnpm
> smoke:sql`'s live check fails with a check-constraint violation from a migration replay (e.g.
> `agent_runs_review_status_check`) hitting a row like `review_status = 'not-a-real-review-status'`
> that no normal code path could ever have written. Fix: find and delete the offending row(s)
> (`SELECT id, review_status FROM agent_runs WHERE review_status NOT IN (...)`), not a code bug.

## Smoke tests (services)
`pnpm smoke:all` exercises the running stack (SQL/browser/API/ML/privacy) and retains
artifacts under `out/smoke/`. These need services up (`docker compose up`) and are
**not** part of the ordinary `verify.sh` gate — they validate a deployed stack,
not just a code change. `bash scripts/verify.sh --release` is the stricter
release-only path: it requires a clean candidate, an explicit disposable
database, external artifact locations, release trace, environment identity,
and all deployable image digests before it runs the aggregate smoke. It writes
candidate-bound smoke/test/environment evidence only after the full gate
passes; it is not a substitute for protected CI or independent verification.

### Secure-stack smoke configuration

The running Platform API must use its restricted application `DATABASE_URL`.
The aggregate smoke resets and seeds a disposable database, which requires a
separate administrative connection. Set `SMOKE_DATABASE_ADMIN_URL` to that
disposable administrative URL before `pnpm smoke:all`; the runner uses it only
for reset/seed and SQL-RLS setup, while the Platform API retains its original
application URL. Do not grant truncate or ownership privileges to the
application role to make a smoke pass.

The aggregate runner honors `PSQL` when supplied and otherwise discovers the
standard Homebrew PostgreSQL 16 client path before falling back to `psql` on
`PATH`.

### Independent release challenge

`scripts/release-challenge.mjs` is the clean-checkout harness used after a
candidate manifest has been generated. It always re-verifies the signed
manifest from the supplied candidate checkout and requires its `--runner-id`
to differ from the build-provenance `builderId`.

`--verify-manifest-only` is useful for an adversarial manifest challenge, but
its external report is deliberately labeled `manifest-verified-only`; it is
not release proof. `--run-release` additionally requires a dedicated
`RELEASE_DATABASE_URL`, fresh external smoke/test/environment destinations,
image digests from the verified manifest, and a release trace. It reruns
`bash scripts/verify.sh --release` in the clean candidate checkout and writes
`status: "passed"` only when that complete rerun succeeds. The protected CI
job and an independently retained successful/adversarial run remain P0.7
requirements; the local harness does not claim they have happened.

## Verifying RLS enforcement (production posture)
The tenant-isolation policies (`infra/sql/0003_tenant_rls.sql`,
`0009_learner_progress_rls.sql`) only bite when the connecting role is **not** a superuser
and lacks **BYPASSRLS**. The dev role (`hawzhin`) is a superuser and bypasses RLS, so in dev
isolation is enforced by the app-level `WHERE tenant_id = $1` clauses plus the per-request
`SET LOCAL app.tenant_id` that `begin_tenant_tx` applies. To prove RLS itself is the backstop,
run the API as the restricted role:

```bash
# 1. Create the restricted role (idempotent). NOT superuser, NOT bypassrls.
psql "$SUPERUSER_URL" -v app_password="$STRONG_PASSWORD" -f infra/sql/rls-app-role.sql

# 2. Run platform-api as that role and smoke it.
DATABASE_URL="postgresql://quran_ai_app:$STRONG_PASSWORD@localhost:5432/quran_ai" \
ALLOW_HEADER_AUTH=1 ALLOW_INSECURE_DEFAULTS=1 JWT_SECRET=dev PLATFORM_API_BIND=127.0.0.1:8085 \
  ./services/platform-api/target/debug/quran-ai-platform-api &
PLATFORM_API_SMOKE_URL=http://127.0.0.1:8085 node scripts/smoke-api.mjs
```

Expected: `status:"pass"`, `sameTenant:200`, `otherTenant:404` (cross-tenant read blocked by
RLS, not just by the WHERE clause), and no unexpected 500s. The `SET LOCAL app.bypass_rls`
escape hatch is ignored for non-superuser roles, so the app role stays subject to the policies
even if that custom GUC is set.

The **live SQL RLS smoke** proves the policies in isolation without the app:

```bash
POSTGRES_RLS_SMOKE_URL="$DATABASE_URL" node scripts/smoke-sql.mjs
# -> live.status "passed", 15 tenant tables (see `tenantTables` in scripts/smoke-sql.mjs
# for the current list — it's grown since this doc was first written), transaction-rollback mode
```

## Conventions
- Every spec.md acceptance criterion (EARS) maps to ≥1 automated test that runs in `verify.sh`.
- Property/fuzz tests for pure logic (parsers, checksums, contracts) where cheap.
- DB/network/service-dependent tests are gated behind availability, never stubbed to fake green.

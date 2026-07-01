# Testing

## The gate
`bash scripts/verify.sh` is the single source of "does it work". It runs:

1. **guard** — fails if any secret/protected file (`.env`, `secrets/`, `*.pem`) is tracked.
2. **lint** — `cargo fmt --check` + `cargo clippy -D warnings` for both Rust services.
   (TS has no separate linter; type safety is the TS lint, run next.)
3. **typecheck** — `tsc` for `@quran-ai/contracts`, `@quran-ai/quran-data`, `@quran-ai/web`.
4. **test** — vitest for the three TS packages; `node --test` for the Node services
   (`ml-inference/alignment.test.mjs`, `agents/agents.test.mjs`, run by explicit path
   because a dir glob would import the listening `server.mjs`); `cargo test` for both
   Rust services.
5. **build** — `pnpm build` (contracts + quran-data + web).

`bash scripts/verify.sh --fast` runs only lint + typecheck (used by the PostToolUse hook).

> **verify.sh vs `pnpm test` / `pnpm proof`.** The two legacy commands run the platform-api
> integration tests with `--include-ignored` *unconditionally*, so they **fail** without a
> live Postgres. `verify.sh` is the gate that **skips** those tests when no DB is reachable
> (it never fakes them) — that's why CI (which has no DB) stays green on `verify.sh`.

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

## Smoke tests (services)
`pnpm smoke:all` exercises the running stack (SQL/browser/API/ML/privacy) and retains
artifacts under `out/smoke/`. These need services up (`docker compose up`) and are
**not** part of `verify.sh` — they validate a deployed stack, not a code change.

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
# -> live.status "passed", 14 tenant tables, transaction-rollback mode
```

## Conventions
- Every spec.md acceptance criterion (EARS) maps to ≥1 automated test that runs in `verify.sh`.
- Property/fuzz tests for pure logic (parsers, checksums, contracts) where cheap.
- DB/network/service-dependent tests are gated behind availability, never stubbed to fake green.

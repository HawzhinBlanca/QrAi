# Testing

## The gate
`bash scripts/verify.sh` is the single source of "does it work". It runs:

1. **guard** — fails if any secret/protected file (`.env`, `secrets/`, `*.pem`) is tracked.
2. **lint** — `cargo fmt --check` + `cargo clippy -D warnings` for both Rust services.
   (TS has no separate linter; type safety is the TS lint, run next.)
3. **typecheck** — `tsc` for `@quran-ai/contracts`, `@quran-ai/quran-data`, `@quran-ai/web`.
4. **test** — vitest for the three TS packages; `cargo test` for both Rust services.
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

## Conventions
- Every spec.md acceptance criterion (EARS) maps to ≥1 automated test that runs in `verify.sh`.
- Property/fuzz tests for pure logic (parsers, checksums, contracts) where cheap.
- DB/network/service-dependent tests are gated behind availability, never stubbed to fake green.

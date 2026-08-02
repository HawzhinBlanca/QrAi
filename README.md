# Quran AI

Quran AI is being built into a Quran Recitation Intelligence OS: learner recitation, realtime Quran-constrained alignment, confidence-scored tajweed feedback, teacher review, scholar/source approval, and model-evaluation proof gates.

## Current Boundary

This repo implements a meaningful, testable vertical slice of the 10/10 platform:

- `apps/web` is the React/Vite learner practice app, with a pilot-invite session path and an internal review surface kept out of the default learner route.
- `packages/contracts` owns shared API, data, canonical-checksum, retention, and learner-facing source/review gate contracts.
- `packages/quran-data` owns immutable, checksum-validated Quran and translation import bundles plus SQL seed generation.
- `services/platform-api` is a Rust/Axum + SQLx/Postgres tenant-scoped API for recitation, progress, reviews, approvals, privacy, audit events, pilot sessions, and realtime tickets. Its tenant-owned data paths use Postgres RLS.
- `services/realtime-gateway` is a Rust/Tokio gateway with ticket-gated WebSocket ingress, bounded backpressure, metrics, and reconnect coverage.
- `services/ml-inference` performs Quran-constrained alignment and rule-based tajweed finding generation, while consent-gated ASR is proxied to the self-hosted inference service.
- `infra/sql` defines the core schema, forced tenant RLS, and structured `agent_runs.learner_id` support so privacy export/delete can include learner-linked agent runs.
- `docs/architecture/10-10-platform.md`, `docs/readiness/`, and `specs/readiness-recovery-10-10/tasks.md` describe the architecture, proof gates, and current release status.

It is **not release-ready**: candidate-bound model evaluation, independent security/privacy review, live operational proof, human sign-offs, and production deployment evidence remain open. The running ASR deployment uses generic Whisper `base`, not a Quran-tuned production model; learner-facing AI feedback remains source- and review-gated.

## Stack

- Web: React 19, Vite 8, TypeScript 6, Tailwind CSS 4, Lucide, Motion, Recharts, Vitest.
- Contracts: TypeScript, Vitest.
- Realtime foundation: Rust 1.96, Tokio, bounded `mpsc` channels.
- Planned platform services: Rust/Tokio/Axum, Python/PyTorch/FastAPI, Postgres + pgvector, NATS JetStream, object storage, Redis, OpenTelemetry/Sentry.

## Run Locally

```bash
pnpm install
pnpm dev
```

The web app runs through the root script and serves `apps/web`.

Run the realtime gateway in another terminal when testing WebSocket audio upload:

```bash
pnpm gateway:dev
```

By default it listens on `127.0.0.1:8081`, matching `VITE_REALTIME_GATEWAY_URL` in `.env.example`.

Run the platform API in another terminal when testing tenant-scoped workflows:

```bash
pnpm api:dev
```

By default it listens on `127.0.0.1:8080`, matching `VITE_PLATFORM_API_URL` in `.env.example`.

With the gateway running, smoke-test binary WebSocket audio ingestion:

```bash
pnpm smoke:gateway
pnpm smoke:api
```

Validate SQL tenant isolation statically:

```bash
pnpm smoke:sql
```

`pnpm smoke:sql` also runs a transactional live Postgres RLS proof when `POSTGRES_RLS_SMOKE_URL` or `DATABASE_URL` is set. Use `SQL_SMOKE_REQUIRE_LIVE=true pnpm smoke:sql` in CI to fail when no live Postgres database is available. The live mode requires `psql` on `PATH`.

## Verify

```bash
bash scripts/verify.sh   # CODYSTEM gate: guard + Rust fmt/clippy + TS typecheck + tests + build
bash scripts/verify.sh --release # clean-candidate gate: dedicated DB + full-stack smoke + external evidence
pnpm test                # same checks, but runs platform-api integration tests (needs live Postgres)
pnpm build
pnpm proof               # legacy strict gate (scripts/proof.sh); also needs live Postgres
pnpm smoke:all
```

`bash scripts/verify.sh` is the canonical gate (what CI runs). It runs the guard, Rust
fmt/clippy/test for both `realtime-gateway` and `platform-api`, TS typecheck/test/build for
`contracts` + `quran-data` + `web`, and **skips** the Postgres-only platform-api integration
tests when no DB is reachable (it never fakes them).
`bash scripts/verify.sh --release` refuses a dirty checkout and requires an explicitly
configured disposable database, external smoke/test/environment evidence paths, a release
trace, environment identity, and complete image digests. A release build must also produce a
separate candidate-bound build-provenance record that the signed manifest hashes and verifies.
The gate then runs the live integration suite and aggregate smoke before writing candidate-bound
evidence. Run it only from protected CI or a deliberately isolated release environment; a
successful local ordinary gate is not release certification.
`pnpm proof` (`scripts/proof.sh`) runs the same checks but executes the platform-api tests
with `--include-ignored`, so it **requires** a live Postgres.
`pnpm smoke:all` runs proof plus SQL, browser, Platform API, realtime gateway, ML, and privacy smoke with retained artifacts under `out/smoke/`.

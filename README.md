# Quran AI

Quran AI is being built into a Quran Recitation Intelligence OS: learner recitation, realtime Quran-constrained alignment, confidence-scored tajweed feedback, teacher review, scholar/source approval, and model-evaluation proof gates.

## Current Boundary

This repo now implements the foundation slice of the 10/10 platform plan:

- `apps/web` keeps the existing React/Vite platform command app.
- `packages/contracts` owns shared TypeScript contracts, API routes, event subjects, core table names, canonical checksum helpers, audio-retention logic, and learner-facing AI source/review gates.
- `packages/quran-data` owns the canonical Al-Fatihah seed, source manifests, immutable import bundles, checksum validation, and SQL seed generation.
- `apps/web` includes a browser mic capture path that emits typed audio chunk envelopes and mocked partial alignment events until backend WebSocket streaming is connected.
- `services/platform-api` provides the first Rust/Axum tenant-scoped platform API for recitation sessions, realtime tickets, teacher reviews, scholar approvals, eval lookup, privacy jobs, audit events, and explicit local RBAC headers.
- `services/realtime-gateway` contains the first Rust/Tokio realtime audio gateway with bounded channels, ticket-gated WebSocket ingress, metrics counters, and async tests.
- `services/ml-inference` provides a local fixture-backed ML inference service for Quran-constrained alignment, source-backed tajweed findings, eval thresholds, privacy export/delete, and consent-gated external ASR stubs.
- `infra/sql/0001_core_schema.sql` defines the initial Postgres target schema, and `infra/sql/0003_tenant_rls.sql` defines tenant RLS policies with forced RLS for tenant-owned tables.
- `docs/architecture/10-10-platform.md` and `docs/proof/10-10-proof-checklist.md` document the architecture and proof gates.

It still does not run a real trained Quran ASR/tajweed model, enforce production identity-provider auth, move the Platform API to SQLx/Postgres repositories, provision Postgres/NATS/object storage/OpenAI Realtime/OpenAI Agents/Expo mobile, or prove object-storage tenant isolation. Those systems now have explicit contract, schema, and smoke-test targets.

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
pnpm test
pnpm build
pnpm proof
pnpm smoke:all
```

`pnpm proof` runs the strictest local gate: contract tests, web tests/build, Rust gateway tests, and Rust clippy with warnings denied.
`pnpm smoke:all` runs proof plus SQL, browser, Platform API, realtime gateway, ML, and privacy smoke with retained artifacts under `out/smoke/`.

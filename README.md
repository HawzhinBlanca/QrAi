# Quran AI

Quran AI is being built into a Quran Recitation Intelligence OS: learner recitation, realtime Quran-constrained alignment, confidence-scored tajweed feedback, teacher review, scholar/source approval, and model-evaluation proof gates.

## Current Boundary

This repo implements a meaningful, testable vertical slice of the 10/10 platform:

- `apps/flutter` is the lean target learner client; React/Vite `apps/web` and Expo `apps/mobile`
  remain measured compatibility surfaces until their caller-removal gates pass.
- `packages/contracts` owns shared API, data, canonical-checksum, retention, and learner-facing source/review gate contracts.
- `packages/quran-data` owns immutable, checksum-validated Quran and translation import bundles plus SQL seed generation.
- `services/platform-api` is a Rust/Axum + SQLx/Postgres tenant-scoped API for recitation, progress, reviews, approvals, privacy, audit events, pilot sessions, and realtime tickets. Its tenant-owned data paths use Postgres RLS.
- `services/realtime-gateway` is a Rust/Tokio gateway with ticket-gated WebSocket ingress, bounded backpressure, metrics, and reconnect coverage.
- `server` is the single Node production package and image. Compose runs it as `node-api`,
  `job-worker`, and the internal no-traffic `node-realtime` process shell; the worker owns durable
  execution, retained-audio lifecycle, Quran-constrained
  alignment, and deterministic Tajweed instruction. A pinned Muaalem v3.2 adapter runs only as
  private, uncalibrated shadow evaluation on retained audio and server-derived spans; it returns no
  learner findings until calibration, evaluation, scholar, licence, and review gates pass.
- `infra/migrations` is the immutable, checksum-pinned schema history. The one-shot Node runner
  serializes application with a Postgres advisory lock, records each file in `schema_migrations`,
  and refuses source/database drift. Restricted runtime-role provisioning lives separately under
  `infra/provision`.
- `docs/architecture/10-10-platform.md`, `docs/readiness/`, and `specs/readiness-recovery-10-10/tasks.md` describe the architecture, proof gates, and current release status.

It is **not release-ready**: candidate-bound model evaluation, independent security/privacy review, live operational proof, human sign-offs, and production deployment evidence remain open. The running ASR deployment uses generic Whisper `base`, not a Quran-tuned production model; learner-facing AI feedback remains source- and review-gated.

## Stack

- Web: React 19, Vite 8, TypeScript 6, Tailwind CSS 4, Lucide, Motion, Recharts, Vitest.
- Contracts: TypeScript, Vitest.
- Realtime foundation: Rust 1.96, Tokio, bounded `mpsc` channels.
- Backend: one modular Node 22 package/image for API, worker, and realtime roles, retained Rust compatibility
  oracles, Python/FastAPI ASR, Postgres RLS, and private S3-compatible object storage. The lean
  boundary deliberately adds neither Redis nor NATS.

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

Apply schema changes only through the shared migration boundary, using an administrative URL;
then provision or rotate the restricted runtime role separately:

```bash
MIGRATION_DATABASE_URL="postgresql://admin@localhost:5432/quran_ai" pnpm db:migrate
MIGRATION_DATABASE_URL="postgresql://admin@localhost:5432/quran_ai" \
APP_DATABASE_PASSWORD="<strong-runtime-password>" pnpm db:provision
```

Compose, CI, staging recreation, restore, and release use these same three Node entry points. The
application itself must use the resulting `quran_ai_app` credential, never the migration URL.

The transitional gateway must set `PLATFORM_API_URL` so a stored retained chunk becomes a durable
tenant-scoped index before teacher playback can find it. Compose wires the internal URL. If
`realtime_gateway_chunks_stored_unindexed_total` rises, preview and then apply the ownership-safe
repair against a mounted audio store:

```bash
DATABASE_URL="postgresql://quran_ai_app@localhost:5432/quran_ai" \
AUDIO_STORAGE_DIR=/path/to/audio-storage pnpm db:repair-audio-index
DATABASE_URL="postgresql://quran_ai_app@localhost:5432/quran_ai" \
AUDIO_STORAGE_DIR=/path/to/audio-storage pnpm db:repair-audio-index -- --apply
```

The command never derives ownership from a path alone: path, sidecar, retained bytes, and the
tenant-scoped session/learner row must agree. Compose operators can use the read-only volume profile
documented in `docs/STAGING_RUNBOOK.md`.

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

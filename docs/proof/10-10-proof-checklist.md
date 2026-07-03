# Quran AI Proof Checklist

## Local Proof Now

- [x] `pnpm install` completes with workspace packages.
- [x] `pnpm --filter @quran-ai/contracts test` proves API routes, event subjects, canonical checksums, learner-facing AI gates, signed realtime ticket fields, and retention logic.
- [x] `pnpm --filter @quran-ai/quran-data test` proves canonical Al-Fatihah import counts, source manifests, immutability, checksum tamper detection, SQL schema compatibility, and the server-only full Quran package boundary for the alquran.cloud 114-surah/6236-ayah bundle.
- [x] `pnpm --filter @quran-ai/web test` proves existing recitation helpers, browser mic support detection, audio chunk envelope shape, denied/error mic states, mocked partial alignment events, and platform helper behavior.
- [x] `pnpm --filter @quran-ai/web build` proves web typecheck and production build.
- [x] `cargo fmt --manifest-path services/realtime-gateway/Cargo.toml --check` proves Rust formatting.
- [x] `cargo test --manifest-path services/realtime-gateway/Cargo.toml` proves bounded realtime audio session behavior, signed realtime ticket claim validation, gateway route construction, metrics counters, and WebSocket ingress compilation.
- [x] `cargo clippy --manifest-path services/realtime-gateway/Cargo.toml -- -D warnings` proves Rust gateway lint cleanliness.
- [x] `cargo test --manifest-path services/platform-api/Cargo.toml` proves tenant-scoped recitation session access, role-specific API denial, signed realtime ticket issuance, teacher review audit events, scholar source/risk gates, and eval lookup.
- [x] `cargo clippy --manifest-path services/platform-api/Cargo.toml -- -D warnings` proves Rust platform API lint cleanliness.

## Next Proof Gates

- [x] Seeded canonical Al-Fatihah ingestion validates ayah/word counts and source checksums against Tanzil/Quran Foundation source manifests.
- [x] Server-only full Quran bundle validation loads all 114 surah files and verifies manifest ayah/word totals for the alquran.cloud quran-uthmani source.
- [ ] Independent Quran Foundation/Tanzil reconciliation validates full Quran ayah/word counts and source checksums against a second canonical source.
- [x] Browser mic capture handles support detection, denied/error states, and chunk-shape cases in unit tests.
- [x] App DOM smoke test renders the command center, starts mocked live recitation, emits one audio chunk, and updates aligned-word telemetry.
- [x] Frontend WebSocket upload client builds gateway URLs, parses acknowledgements, gates sends by socket readiness, and is covered by smoke test.
- [x] `pnpm smoke:gateway` sends a binary WebSocket frame to the running gateway and verifies an accepted `audio.ack`.
- [x] `pnpm smoke:gateway` rejects missing, expired, session-mismatched, and replayed realtime tickets before/after accepting a valid ticketed WebSocket audio frame.
- [x] Realtime gateway p95 in-process ingestion latency is under 150ms for 100 simulated concurrent sessions.
- [x] Learner-first browser smoke renders home and practice views, saves desktop/mobile screenshots, and verifies no horizontal overflow through `pnpm smoke:browser`.
- [x] Browser mic capture handles allowed, denied, and smoke-simulated missing-device cases in Chrome browser automation.
- [x] Word alignment F1 is at least 0.90 on deterministic Al-Fatihah + Juz Amma smoke evaluation fixtures.
- [x] Tajweed false-positive rate is no higher than 8% on deterministic advisory smoke fixtures.
- [x] Teacher agreement is at least 90% on deterministic smoke eval fixtures.
- [x] Unsourced or draft religious explanations are blocked from learner display in current contracts, UI copy, and source-backed smoke fixtures.
- [x] Platform API tenant isolation tests prove one tenant cannot read another tenant's recitation sessions.
- [x] Platform API smoke issues realtime tickets, writes a real teacher review, checks teacher review queue, validates eval metadata, exercises privacy export/delete jobs, and verifies learner RBAC denial for teacher actions.
- [ ] Production tenant isolation tests prove one institution cannot read another institution's sessions, reviews, or audio in live Postgres/RLS and object storage.
- [x] `pnpm smoke:sql` validates tenant RLS policy text plus forced RLS for 14 tenant-owned SQL tables.
- [x] `SQL_SMOKE_REQUIRE_LIVE=true POSTGRES_RLS_SMOKE_URL=... pnpm smoke:sql` passes against live Postgres.
- [x] `pnpm smoke:api` creates a tenant-scoped session, verifies cross-tenant 404, and checks eval lookup on the running API.
- [x] `pnpm smoke:ml` proves local ML service health, deterministic Al-Fatihah + Juz Amma golden cases, source-backed tajweed fixtures, eval threshold gate, and external ASR consent audit.
- [x] `pnpm smoke:privacy` proves external ASR denial without consent, child-profile guardian gating, opt-in ASR audit, discard-mode export, retained-audio object export, and deletion of retained local audio blobs plus metadata sidecars.
- [x] `pnpm smoke:all` runs proof plus SQL, browser, API, gateway, ML, and privacy smoke with retained artifacts.
- [x] `pnpm smoke:all` retains one `SMOKE_TRACE_ID` across the aggregate summary, browser artifact summary, Platform API audit events, realtime gateway ack, ML traces/audit events, and privacy export/delete report.
- [x] Audio deletion/export smoke tests prove retained local audio blobs and metadata sidecars are exported and deleted for the current local service boundary.
- [ ] Pilot report covers latency, teacher agreement, learner retention, review-time reduction, model accuracy, and governance incidents.

## Latest Full Smoke Artifact

- `out/smoke/2026-07-01T18-43-51-013Z/summary.json` passed `pnpm smoke:all` with trace ID `smoke-trace-e6071f72-90ab-4ad3-aded-aa25153b8296`.

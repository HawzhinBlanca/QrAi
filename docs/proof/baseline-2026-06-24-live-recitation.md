# Baseline Proof - Live Recitation Slice - 2026-06-24

Command:

```bash
pnpm proof
```

Result:

- Contract tests: 1 test file, 5 tests passed.
- Web tests: 3 test files, 16 tests passed.
- Web build: TypeScript and Vite production build passed.
- Rust gateway: 7 tests passed.
- Rust platform API: 6 tests passed.
- Rust quality: `cargo fmt --check` and `cargo clippy -D warnings` passed.
- Runtime smoke: `pnpm smoke:gateway` returned an accepted `audio.ack` from the running gateway.
- Runtime smoke: `pnpm smoke:api` created a tenant-scoped recitation session, verified cross-tenant `404`, and returned `fatihah-seed-v1` eval data.

Coverage:

- Contracts: API routes, event subjects, table names, canonical checksums, learner-facing AI gates, retention behavior.
- Web: recitation helpers, platform safety helpers, browser mic support detection, audio chunk envelope shape, denied/error mic states, mocked partial alignment events, live capture summary, WebSocket upload client behavior, and app-level DOM smoke for the live recitation button, chunk send, and ack telemetry.
- Gateway: health/router construction, WebSocket ingress compilation, bounded audio channel behavior, duplicate/missing sessions, channel closure, metrics counters, and 100-session local ingestion p95 under 150ms.
- Platform API: tenant header enforcement, tenant-scoped recitation session read, teacher review audit event, scholar source/risk gates, seeded eval lookup, and live smoke for cross-tenant isolation.
- Runtime: gateway `/health` returned `200 OK`, and binary WebSocket smoke returned `{"kind":"audio.ack","accepted":true}`.
- Runtime: platform API `/health` returned `200 OK`, and API smoke returned same-tenant `200` plus cross-tenant `404`.

This still does not prove real WebSocket streaming to the Rust service, production ML alignment, Quran-specific tajweed accuracy, tenant-auth enforcement, or institutional pilot readiness.

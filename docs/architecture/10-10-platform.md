# Quran AI 10/10 Platform Architecture

## Current Implemented Slice

This repo now has the first enforceable foundation for the Quran Recitation Intelligence OS:

- `apps/web`: the existing React/Vite platform command app.
- `packages/contracts`: shared TypeScript contracts for platform records, canonical Quran records, API routes, event subjects, storage tables, proof gates, checksum verification, retention decisions, and learner-facing AI gates.
- `packages/quran-data`: canonical Al-Fatihah seed, Tanzil/Quran Foundation source manifests, immutable import bundles, checksum validation, SQL seed generation, and a server-only full Quran alquran.cloud bundle exposed through `@quran-ai/quran-data/full-quran`.
- `apps/web/src/lib/liveRecitation.ts`: browser mic capture wrapper, audio chunk envelopes, mocked partial alignment events, and live capture summary helpers.
- `services/platform-api`: Rust/Axum + SQLx/Postgres tenant-scoped API for auth, recitation sessions, progress, privacy export/delete, teacher reviews, scholar approvals, eval lookup, audit events, and realtime ticket issuance.
- `services/realtime-gateway`: Rust/Tokio/Axum realtime gateway with health route, WebSocket audio ingress, bounded-channel ingestion, metrics counters, and 100-session local ingestion proof.
- `infra/sql`: Postgres schema, full Quran seed, tenant RLS policies, restricted app role, learner-progress RLS, eval-run tenant isolation, and superuser-only RLS bypass guard.
- `scripts/verify.sh`: canonical local/CI gate for Rust fmt/clippy, TS typecheck, TS/Rust/Node tests, live Postgres integration tests when reachable, production build, and web bundle secret scan.
- `scripts/smoke-*.mjs`: running-stack proof for SQL/RLS, API, gateway, ML, privacy, browser, and trace-linked aggregate smoke.

## Architecture Direction

The winning architecture is a real vertical slice first:

1. Learner app captures mic audio and chunks it locally.
2. Realtime gateway applies bounded backpressure and emits session events.
3. Canonical Quran text constrains word alignment and tajweed findings.
4. Low-confidence findings go to teachers before becoming learner-facing claims.
5. Religious explanations require source references and human review status.
6. Reviewed corrections become labeled eval/training data.
7. Model releases are blocked unless benchmark and trust gates pass.

## Non-Negotiable Rules

- Arabic Quran text is canonical, checksummed, and never machine-modified.
- AI output must include source references, confidence, model version, review status, evidence ID, tenant ID, and audit event ID.
- Audio retention defaults to `discard`; storage requires explicit learner consent.
- Agents are supervised tools. They may plan, explain, route, localize, and summarize, but they cannot issue unsourced religious answers.
- Institution data is tenant-scoped by default.

## Still Not Implemented

- Managed production deployment posture: restricted DB role provisioning, production secrets/origins, backups, observability, and branch-protected CI checks.
- Independent Quran Foundation/Tanzil reconciliation for the full Quran bundle.
- Managed object storage for retained audio and privacy deletion beyond the current local filesystem boundary.
- Cross-service NATS/JetStream emission for audit/event fanout.
- Quran Foundation/Tanzil live reconciliation job.
- Quran-specific ASR/alignment/tajweed ML service.
- OpenAI Realtime/Agents SDK integration.
- Expo mobile app.
- Production institution auth provider/RBAC (OIDC/OAuth or equivalent), beyond the current JWT/login implementation.
- Real pilot data and teacher/scholar workflows.

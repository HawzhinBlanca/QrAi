# Quran AI 10/10 Platform Architecture

## Current Implemented Slice

This repo now has the first enforceable foundation for the Quran Recitation Intelligence OS:

- `apps/web`: the existing React/Vite platform command app.
- `packages/contracts`: shared TypeScript contracts for platform records, canonical Quran records, API routes, event subjects, storage tables, proof gates, checksum verification, retention decisions, and learner-facing AI gates.
- `packages/quran-data`: canonical Al-Fatihah seed, Tanzil/Quran Foundation source manifests, immutable import bundles, checksum validation, and SQL seed generation.
- `apps/web/src/lib/liveRecitation.ts`: browser mic capture wrapper, audio chunk envelopes, mocked partial alignment events, and live capture summary helpers.
- `services/platform-api`: Rust/Axum tenant-scoped API for recitation sessions, teacher reviews, scholar approvals, eval lookup, and audit events.
- `services/realtime-gateway`: Rust/Tokio/Axum realtime gateway with health route, WebSocket audio ingress, bounded-channel ingestion, metrics counters, and 100-session local ingestion proof.
- `infra/sql/0001_core_schema.sql`: Postgres target schema for institutions, users, canonical Quran text, recitation sessions, audio chunks, alignments, findings, reviews, agent runs, model versions, eval runs, consent, and audit events.
- `scripts/proof.sh`: local proof command for contracts, web app, and gateway tests.

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

- Production Postgres runtime, SQLx integration, row-level security, and full Quran live ingestion.
- Authenticated WebSocket sessions, persisted audio events, and cross-service NATS emission.
- Quran Foundation/Tanzil live ingestion job.
- Quran-specific ASR/alignment/tajweed ML service.
- OpenAI Realtime/Agents SDK integration.
- Expo mobile app.
- Production institution auth/RBAC.
- Real pilot data and teacher/scholar workflows.

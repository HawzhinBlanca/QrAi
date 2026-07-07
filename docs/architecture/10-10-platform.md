# Quran AI 10/10 Platform Architecture

## Current Implemented Slice

- `apps/web`: React/Vite platform command app — learner practice flow (record → real ASR
  transcription → alignment/tajweed feedback) and the internal ops console (agent runs, scholar
  queue, live recitation streaming, benchmark/eval view).
- `apps/mobile`: Expo/React Native learner app (login, surah picker, consent-gated recording,
  ASR + alignment feedback via the platform API). Not a pnpm workspace member; its pure-logic
  helpers (`lib/session.ts`) have their own `node --test` suite, gated in
  `.github/workflows/mobile.yml`.
- `packages/contracts`: shared TypeScript contracts for platform records, canonical Quran
  records, API routes, event subjects, storage tables, proof gates, checksum verification,
  retention decisions, and the learner-facing AI gate (`canShowLearnerFacingAiOutput`, an
  allowlist of reviewed statuses).
- `packages/quran-data`: canonical Al-Fatihah seed (checksum-verified via `@quran-ai/contracts`),
  Tanzil/Quran Foundation source manifests, and a server-only full 114-surah bundle
  (`fetch-full-quran.mjs` + `scripts/seed-full-quran-to-db.sh`) seeded into
  `canonical_ayahs`/`canonical_words`.
- `services/platform-api`: Rust/Axum + SQLx/Postgres tenant-scoped API — auth (register/login,
  bcrypt, JWT), recitation sessions, learner progress (real SM-2 spaced repetition), privacy
  export/delete (with ML-service audio erasure), teacher reviews, scholar approvals, agent-run
  recording, eval-run lookup, audit events, and realtime ticket issuance. Tenant isolation
  enforced by Postgres RLS on every tenant-owned table. Privacy-delete does not yet cascade to
  `agent_runs` — see `docs/DATA_INVENTORY.md` §1 and PR #58 (open, blocked on a CI migration-list
  edit only a human can make to a protected workflow file).
- `services/realtime-gateway`: Rust/Tokio/Axum realtime gateway — ticket-authenticated (HMAC,
  single-use, tenant-bound) WebSocket audio ingress, origin-checked (CSWSH-resistant), bounded
  per-session channel with backpressure, forwards chunks to ml-inference, metrics endpoint.
- `services/ml-inference`: Node — real Quran-constrained word alignment (Needleman-Wunsch global
  alignment over Arabic-normalized similarity, `alignment.js`) and a rule-based tajweed engine
  (`tajweed.js`: madd, ghunnah, qalqalah, idgham, iqlab, ikhfa, tafkhim). Consent-gated proxying to
  asr-inference for external ASR.
- `services/asr-inference`: Python/FastAPI — real acoustic ASR via `openai-whisper`
  (`ASR_MODEL` configurable; the current deployment runs generic Whisper `base`, not the
  Quran-tuned `tarteel-ai/whisper-base-ar-quran` default in code — see the `ASR_MODEL` comment in
  `docker-compose.yml` for why). API-key gated, rate-limited.
- `services/tajweed-neural`: Python/FastAPI, isolated `.venv312` — experimental neural tajweed
  model (`obadx/muaalem-model-v3`, `Wav2Vec2BertForMultilevelCTC`). Off by default; output is
  explicitly experimental and gated behind human review, same as the rule-based engine.
- `services/agents`: Node — supervised agent workflows (Tajweed Explainer, Mistake Pattern
  Summarizer, Practice Plan Recommender), each producing a sourced, reviewer-gated `agent_run`.
  No agent output reaches a learner without clearing `canShowLearnerFacingAiOutput`.
- `services/shared-ticket`: Rust — HMAC realtime-ticket issuance/validation shared by
  `platform-api` (issuer) and `realtime-gateway` (validator), so the signing logic lives in one
  place.
- `infra/sql`: Postgres schema, full Quran seed, tenant RLS policies (every tenant-owned table),
  restricted app role, learner-progress RLS, eval-run tenant isolation, superuser-only RLS bypass
  guard, per-tenant email uniqueness, and (pending PR #58) the `agent_runs.learner_id`
  erasure-support column.
- `scripts/verify.sh`: canonical local/CI gate — Rust fmt/clippy, TS typecheck, TS/Rust/Node
  tests, live Postgres integration tests when reachable, production build, and web bundle secret
  scan.
- `scripts/smoke-*.mjs`: running-stack proof for SQL/RLS, API, gateway, ML, privacy, browser, and
  trace-linked aggregate smoke.

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

- Managed production deployment posture: restricted DB role provisioning, production
  secrets/origins, backups, observability, and branch-protected CI checks.
- Independent Quran Foundation/Tanzil reconciliation for the full Quran bundle.
- Managed object storage for retained audio and privacy deletion beyond the current local
  filesystem boundary.
- Cross-service NATS/JetStream emission for audit/event fanout.
- OpenAI Realtime/Agents SDK integration (the agents service and ASR are custom-built, not
  built on OpenAI's SDKs — ASR uses locally-run `openai-whisper` model weights only).
- Production institution auth provider/RBAC (OIDC/OAuth or equivalent), beyond the current
  JWT/login implementation.
- Live pilot usage with real learners at scale (the pilot tenant, seed data, and teacher/scholar
  review workflows exist and are exercised by integration tests, but this has not yet been used
  by real learners in the field).
- The Quran-tuned ASR model (`tarteel-ai/whisper-base-ar-quran`) is not actually running in the
  current deployment — it requires `transformers` as a new production dependency, a decision not
  yet made (see `ASR_MODEL` in `docker-compose.yml`).

# Quran AI Full Platform Ship-Ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a full-platform institution pilot where learners complete a calm mastery recitation loop backed by real ML alignment/tajweed feedback, teacher/scholar review, privacy controls, and smoke-tested managed-cloud infrastructure.

**Architecture:** The learner app becomes the primary surface; platform command becomes an internal/admin surface. Rust/Tokio services own tenant-scoped APIs and realtime audio ingress, the ML service owns Quran-constrained ASR/alignment/tajweed predictions with a consent-gated external ASR adapter, and managed Postgres/object storage/eventing/observability provide production proof. All learner-facing AI remains source/review gated through shared contracts.

**Tech Stack:** React 19, Vite 8, TypeScript 6, Tailwind CSS 4, Vitest, Rust 1.96, Tokio, Axum, SQLx, managed Postgres, managed object storage, managed event stream, OpenTelemetry/Sentry, Python/FastAPI/PyTorch or equivalent ML serving, optional external ASR provider for opted-in pilot sessions.

---

## Locked Decisions

- Ship target: full platform for an institution pilot, not only a web demo.
- First audience: Quran institution learners with teacher and scholar review.
- Learner tone: calm mastery with missions, mastery rings, gentle streaks, and respectful micro-celebration.
- Deployment bias: managed cloud for database, storage, queue/eventing, observability, and secrets.
- AI/audio policy: opted-in learner audio may be sent from the backend to an external ASR provider for the pilot; non-opted-in sessions do not use external ASR, and child/private profiles require guardian/institution consent before external processing.
- Release gate: pilot gate plus full ML thresholds before calling the system ship-ready.

## Public Interfaces And Data Contracts

Extend `packages/contracts/src/index.ts` first, then mirror the same shapes in Rust and ML service DTOs:

- `Consent` gains `externalAsrProcessing: boolean`, `guardianApproved: boolean`, and `consentVersion: string`; default is `false`, and `audioRetention` remains independent.
- `RecitationSession` gains `mode: "listen" | "guided-recite" | "memory-recite" | "correction" | "drill" | "complete"`, `practicePlanId`, and `externalProcessingAllowed`.
- `RealtimeSessionTicket` contains `sessionId`, `tenantId`, `learnerId`, `expiresAt`, `allowedSampleRates`, `externalAsrProcessing`, and a signed `token`.
- `AlignmentPredictionRequest` contains tenant/session IDs, Quran reference, canonical checksum, audio evidence IDs, sample rate, language, and consent snapshot.
- `AlignmentPredictionResponse` returns `WordAlignment[]`, `latencyMs`, `modelVersion`, `datasetVersion`, `confidence`, `reviewStatus`, `evidenceId`, and `auditEventId`.
- `TajweedPredictionResponse` returns `TajweedFinding[]` with rule, severity, confidence, sources, model version, review status, and audit ID.
- `ModelEvalRun` must expose `wordAlignmentF1`, `tajweedF1`, `falsePositiveRate`, `teacherAgreementRate`, `unsourcedLearnerOutputs`, `passed`, and dataset version.

Required API surface:

- Platform API: `POST /v1/recitation-sessions`, `GET /v1/recitation-sessions/:id`, `POST /v1/realtime-session-tickets`, `POST /v1/teacher-reviews`, `GET /v1/teacher-review-queue`, `POST /v1/scholar-approvals`, `GET /v1/eval-runs/:modelVersion`, `POST /v1/privacy/export`, `POST /v1/privacy/delete`, `GET /v1/audit-events`.
- Realtime gateway: `GET /health`, `GET /v1/recitation-sessions/:id/audio?ticket=...`, and server-emitted events for audio ack, partial alignment, finding created, backpressure, and session closed.
- ML inference: `POST /v1/alignments:predict`, `POST /v1/tajweed-findings:predict`, `POST /v1/eval-runs`, `GET /health`.
- Agents: supervised workflows only; learner-facing output must pass source/review gates before display.

## Implementation Phases

### Phase 1: Learner-First App Shell

- [ ] Replace the default `PlatformCommand` first screen with a learner home: today's mission, one `Start Practice` action, mastery summary, next review, and small trust state.
- [ ] Keep platform command, teacher, scholar, model ops, and trust ledger as internal/admin surfaces behind role-aware navigation.
- [ ] Build the practice state machine: listen, guided recite, memory recite, correction, drill, complete.
- [ ] Reuse and refactor the current Quran reader/audio coach/issue/progress components so the Arabic text is central and all gateway/model details are hidden from learners.
- [ ] Make mobile first-class: no horizontal overflow at 390px, 430px, 768px, 1024px, and 1440px; use mobile bottom nav and desktop sidebar.
- [ ] Add empty, denied mic, gateway unavailable, low-confidence, sent-to-teacher, and complete states.

### Phase 2: Contracts, Database, And Platform API

- [x] Extend TypeScript contracts with consent, realtime ticket, prediction, eval, privacy, and practice-session types.
- [x] Add SQL migrations for external ASR consent snapshots, realtime tickets, alignment runs, ML eval metrics, privacy export/delete jobs, and RLS-compatible tenant fields.
- [ ] Move platform API from in-memory store to SQLx-backed Postgres repositories.
- [ ] Enforce tenant isolation in SQLx-backed API queries and live database RLS; cross-tenant reads must return 404 or 403 according to endpoint semantics.
- [x] Add local privacy export/delete endpoints and smoke coverage for session/audio/model-use boundaries.
- [x] Keep local audit events for session start, ticket issue, teacher review, scholar approval, privacy export, and privacy deletion.

### Phase 3: Authenticated Realtime Audio

- [x] Require signed realtime tickets on WebSocket connect in the local gateway smoke path.
- [x] Platform API issues local signed tickets carrying session, tenant, learner, external-ASR consent, expiry, and nonce.
- [ ] Validate production ticket tenant, learner, and consent snapshot against SQLx/Postgres source-of-truth before accepting audio.
- [x] Validate local gateway ticket signature, expiry, session binding, tenant/learner/consent claim shape, and replay rejection before accepting audio.
- [ ] Keep bounded channels and backpressure counters; add per-session cancellation, idle timeout, close reason, and structured metrics.
- [ ] Emit server-side events for audio ack, partial alignment, model latency, backpressure, and session closed.
- [ ] Persist audio chunk metadata; persist object storage keys only when retention is `teacher-review` or `training-opt-in`.
- [ ] Add a non-storage path for `discard` sessions where audio is processed ephemerally and only derived findings/audit records remain.

### Phase 4: Full ML Vertical Slice

- [ ] Implement the ML inference service with health, alignment prediction, tajweed prediction, and eval-run endpoints.
- [ ] Add the hybrid external ASR adapter: call the provider only when `externalAsrProcessing` is true, tenant pilot policy allows it, and the consent snapshot is valid.
- [ ] Add a self-hosted/local fallback path for non-opted-in sessions; if local ML is not available, the UI must show "teacher review required" rather than fake confidence.
- [ ] Constrain ASR output against canonical Quran words and checksums; never machine-edit canonical text.
- [ ] Produce word-level alignment statuses: matched, misread, missed, extra, needs-review.
- [ ] Produce tajweed findings only with model version, confidence, source references, review status, and audit ID.
- [ ] Build curated eval datasets for Al-Fatihah and Juz Amma with reviewed labels.
- [ ] Block learner release until word alignment F1 is at least 0.90, tajweed false-positive rate is at most 8%, teacher agreement is at least 90%, and unsourced learner-facing outputs equal 0.

### Phase 5: Teacher, Scholar, And Agent Review

- [ ] Add teacher review queue sorted by low confidence, repeated learner issue, severity, and waiting time.
- [ ] Let teachers accept, reject, or edit model findings with short notes and audio snippet access only when consent permits it.
- [ ] Feed teacher decisions into agreement metrics and eval datasets.
- [ ] Add scholar/source approval for tajweed explanations, mutashabihat explanations, localization, and sensitive religious content.
- [ ] Keep agents as drafting/routing tools only; they may not publish learner-facing answers without contract-level source/review gates.
- [ ] Show learners simple statuses: reviewed guidance, sent to teacher, source available, blocked pending review.

### Phase 6: Privacy, Security, And Managed Cloud Readiness

- [ ] Provision managed Postgres, object storage, event stream, secrets, and observability with environment-specific configuration.
- [ ] Add server-side auth/RBAC for learner, teacher, scholar, admin, and ops roles.
- [ ] Implement child/family safeguards: guardian consent, child profile defaults, no ads/tracking in child mode, and age-appropriate notifications.
- [ ] Implement external ASR provider logging with no raw secrets in logs, no audio retention by provider beyond policy, and audit events for every provider call.
- [ ] Add data export/delete job processing and object-storage deletion verification.
- [ ] Add security checks for tenant isolation, ticket expiry/replay, object-key access, audit integrity, and missing consent.

### Phase 7: Ship Gate And Smoke Harness

- [ ] Add `pnpm smoke:browser` for learner home, start practice, mic allowed/denied states, one realtime ticket request, feedback display, retry drill, completion, and mobile no-overflow screenshot proof.
- [x] Add `pnpm smoke:ml` for ML health, golden-audio alignment prediction, tajweed prediction, eval metrics, and external ASR consent gating.
- [x] Add `pnpm smoke:privacy` for export/delete and external-ASR denial when consent is false.
- [x] Add `pnpm smoke:all` to run API, gateway, ML, browser, privacy, and existing proof gates against local services.
- [x] Save smoke artifacts under `out/smoke/<timestamp>/`: logs, screenshots, eval JSON, latency summary, privacy deletion report, and service versions.
- [x] Update `docs/proof/10-10-proof-checklist.md` so every ship gate has a command and retained evidence path.

## Smoke And Ship-Ready Gate

The app is not ship-ready until all checks pass in a clean checkout:

```bash
pnpm install
pnpm proof
pnpm smoke:api
pnpm smoke:gateway
pnpm smoke:ml
pnpm smoke:browser
pnpm smoke:privacy
pnpm smoke:all
```

Required smoke coverage:

- API smoke creates a tenant-scoped session, rejects missing tenant, verifies cross-tenant isolation, issues a realtime ticket, reads eval metrics, and lists audit events.
- Gateway smoke rejects missing/expired tickets, accepts a valid binary audio frame, emits accepted ack, emits backpressure under bounded capacity, and closes idle sessions.
- ML smoke runs a golden Al-Fatihah/Juz Amma sample, returns Quran-constrained alignments, returns tajweed findings, records eval metrics, blocks learner-facing output when thresholds fail, and proves external ASR is called only with consent.
- Browser smoke proves learner home, practice state machine, mic allow/deny/unavailable states, feedback display, teacher escalation, completion, and no horizontal overflow at 390px and 1440px.
- Privacy smoke proves `discard` does not persist audio object keys, opted-in external ASR writes an audit event, export returns expected records, delete removes or tombstones user data and audio keys, and revoked consent blocks future external ASR calls.
- Review smoke proves low-confidence findings enter teacher queue, teacher decisions update agreement metrics, scholar approval requires sources, high-risk approval is blocked, and unsourced learner-facing answers remain zero.
- Observability smoke proves correlated trace IDs from browser artifact summary to Platform API, gateway, ML service, audit events, privacy report, and aggregate smoke artifact.

## Test Plan

- Unit: contracts, canonical checksum immutability, consent gating, learner-facing AI gate, practice state transitions, audio chunk creation, ticket validation, privacy deletion decisions.
- Integration: SQLx repositories, RLS/cross-tenant isolation, gateway ticket validation, object storage retention modes, ML prediction DTOs, external ASR consent adapter.
- E2E: full learner practice loop from session creation to realtime audio to ML prediction to feedback to retry drill to completion.
- Accessibility: keyboard-only learner loop, visible focus, labels for Arabic word tokens, reduced motion, color contrast, mobile target size.
- Performance/load: gateway 100 and 1,000 session ingestion tests, p95 learner feedback latency <= 600ms in pilot region, frontend first usable screen < 2s on mid-tier mobile.
- Model eval: word alignment F1 >= 0.90, tajweed false-positive rate <= 8%, teacher agreement >= 90%, unsourced learner-facing outputs = 0.
- Security/privacy: tenant isolation, token expiry/replay, external ASR consent, child/guardian policy, export/delete, object key authorization, audit events.

## Assumptions

- Institution pilot is the first release target; consumer family/solo modes use the same core loop but are not the first release gate.
- Managed cloud is acceptable for pilot; exact vendor can be selected during infrastructure implementation if it satisfies Postgres, object storage, eventing, secrets, and observability requirements.
- External ASR is allowed only after explicit consent and audit logging; retention and external processing are separate consent decisions.
- Full ML means measured ASR/alignment/tajweed performance, not deterministic mocks. Mocks may remain only for local development and visual tests when clearly labeled.
- The existing `pnpm proof`, API smoke, and gateway smoke remain mandatory and must grow rather than be replaced.
- Platform command remains useful as an internal/admin surface, but learner home is the first screen.

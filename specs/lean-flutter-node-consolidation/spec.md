# Specification — final lean Flutter + Node Quran learning platform

**Status:** proposed<br>
**Owner:** repository owner<br>
**Implementation:** blocked until `plan.md` is approved<br>
**Research:** `research.md` and `audit-2026-08-06.md`

## Objective

Consolidate the existing repository in place into one production Flutter client and one modular Node.js backend, preserving Quran correctness, tenant isolation, privacy, reviewed-feedback safety, and executable migration evidence. Remove superseded clients, Rust implementations, disconnected experiments, obsolete deployment paths, and stale active documentation only after their responsibilities have proven replacements.

## Final product boundary

- Flutter is the sole learner, teacher, and scholar client for Android, iOS, and Web.
- One Node package owns REST, WebSocket realtime, domain workflows, inference orchestration, background work, migrations, and operational entrypoints.
- Postgres remains the system of record and RLS boundary.
- Production retained audio uses private object storage; local filesystem storage is test/development only.
- Canonical Quran and reviewed translation bundles remain immutable, versioned packages.
- The Python ASR worker is transitional and replaceable. It is deleted only if a measured Node/ONNX or on-device alternative passes the same evaluation gate.
- Password register/login and `agent-runs` are recommended for retirement from the final public contract. Production identity uses controlled invitation/device enrollment while the owner's login-off decision remains active.

## Explicit non-goals

- No greenfield repository.
- No in-place mutation or normalization of canonical Quran bundles.
- No learner-visible confidence invented from text rules or fixtures.
- No flag-day deletion of React or Rust.
- No port of every decorative internal dashboard; only learner, teacher, scholar/source approval, privacy, and essential operations survive.
- No CPU-heavy inference on the API event loop.
- No automatic deletion of local `backups*`, `.audit`, `out`, build caches, or other user artifacts.

## EARS acceptance criteria

Every named test below is planned to run from `bash scripts/verify.sh`; tests requiring signed candidates, real models, or devices run through its `--release` evidence-validation mode.

### A. Contract and schema truth

| ID | Criterion | Planned automated test |
|---|---|---|
| CT-1 | WHEN the current Rust router is inventoried before retirement, THE inventory SHALL contain all 42 method/path pairs, including routes separated from `.route(` by comments. | `tests/contract/route-inventory.test.mjs` |
| CT-2 | WHEN a route is added, removed, or retired, THE authoritative API contract SHALL change in the same commit and SHALL contain a non-permissive response schema for every retained operation. | `tests/contract/openapi-completeness.test.mjs` |
| CT-3 | WHEN Node registers routes, THE registered method/path set SHALL equal the approved target contract and SHALL NOT depend on two hand-maintained allowlists. | `tests/node-api/route-registry.test.mjs` |
| CT-4 | WHEN the target contract retires register/login and agent-run routes, THE retirement SHALL be explicit in an accepted ADR and clients SHALL have no caller for them. | `tests/contract/retired-routes.test.mjs` |
| DB-1 | WHEN migrations run against an empty database or the immediately previous schema, THE resulting migration ids, checksums, constraints, RLS policies, and schema fingerprint SHALL match. | `tests/migrations/schema-equivalence.test.mjs` |
| DB-2 | WHEN any tenant-owned query runs, THE connection SHALL use the restricted app role and a tenant-scoped transaction; a superuser or `BYPASSRLS` role SHALL be refused at boot. | `tests/node-api/db-role-guard.test.mjs`, `tests/node-api/db-tenant.test.mjs` |
| DB-3 | WHEN the supported local stack starts, THE same migration runner used by CI SHALL complete before Node becomes ready. | `tests/contract/compose-migrations.test.mjs` |

### B. Quran, alignment, Tajweed, and evaluation correctness

| ID | Criterion | Planned automated test |
|---|---|---|
| QA-1 | WHEN canonical Quran data is served or seeded, THE exact bytes, declared source, ayah hash, word-token hash, and version SHALL match the reviewed manifest. | `packages/quran-data/tests/corpus-provenance.test.ts` |
| QA-2 | WHEN complete real session audio is transcribed or finalized, THE system SHALL preserve only server-derived recognized-token and canonical-alignment spans satisfying `0 <= startMs < endMs` with absolute monotonic offsets; IF audio or span evidence is incomplete, malformed, over limit, or unavailable, THEN it SHALL return an explicit non-finalized reason and persist none. | `services/ml-inference/session-transcript.test.mjs`, `tests/inference/real-audio-spans.test.mjs`, `services/ml-inference/alignment.test.mjs`, `tests/e2e/real-audio-finalize.test.mjs` |
| QA-3 | WHEN a Tajweed finding describes learner performance, THE finding SHALL be derived from acoustic evidence linked to a stored alignment span; a canonical-text rule SHALL be labeled instructional and SHALL NOT claim learner error. | `tests/contract/tajweed-analysis-basis.test.mjs` |
| QA-4 | WHEN feedback is returned to a learner, THE server and Flutter client SHALL require an allowed review status, source, calibrated confidence at or above the approved threshold, evidence id, model id, dataset id, and audit id. | `tests/e2e/learner-feedback-gate.test.mjs`, `apps/flutter/test/tajweed_gate_test.dart` |
| QA-5 | IF confidence is absent, uncalibrated, text-derived, fixture-derived, or below threshold, THEN THE system SHALL withhold the judgment and SHALL NOT substitute a default confidence. | `tests/contract/no-invented-confidence.test.mjs` |
| QA-6 | WHEN a model or alignment result is persisted, THE producing implementation, model artifact digest, dataset version, and analysis basis SHALL remain identical from inference response through database readback. | `tests/e2e/model-provenance-roundtrip.test.mjs` |
| QA-7 | WHEN an evaluation is marked release-passing, THE metrics SHALL be recomputed from a candidate-bound held-out dataset and signed evidence; declared fixtures SHALL remain labeled fixtures and SHALL never clear the release gate. | `tests/release/model-evidence.test.mjs` |
| QA-8 | WHEN the ASR process reports ready, THE selected model SHALL be loaded and a bounded known-audio probe SHALL pass; liveness alone SHALL NOT satisfy readiness. | `tests/inference/asr-readiness.test.mjs` |

### C. Node backend and realtime convergence

| ID | Criterion | Planned automated test |
|---|---|---|
| BE-1 | WHEN the Node backend starts in final mode, THE system SHALL serve every retained API operation without `PLATFORM_API_UPSTREAM` or any Rust process. | `tests/node-api/standalone.test.mjs` |
| BE-2 | WHEN a production identity is enrolled, THE server SHALL exchange a single-use, expiring invitation for a device/session credential without accepting caller-controlled tenant or role. | `tests/e2e/device-enrollment.test.mjs` |
| BE-3 | WHEN requests reach Node, THE service SHALL enforce maintenance mode, bounded rate limits, origin policy, body limits, authorization, RLS, and generic error redaction in the approved order. | `tests/node-api/middleware-order.test.mjs`, `tests/security/node-boundary.test.mjs` |
| BE-4 | IF Postgres, object storage, ASR, or the worker hangs, THEN THE caller SHALL receive a bounded retryable response, the operation SHALL be cancelled, and no partial durable state SHALL be claimed complete. | `tests/faults/dependency-timeouts.test.mjs` |
| BE-5 | WHEN Node receives SIGTERM, THE service SHALL stop accepting work, drain bounded in-flight requests and WebSockets, close the DB pool, and exit within the configured grace period. | `tests/node-api/graceful-shutdown.test.mjs` |
| BE-6 | WHEN retained audio is written, exported, read for review, or deleted, THE object-store operation and database evidence SHALL be tenant-scoped, auditable, retry-safe, and privacy-contract compliant. | `tests/e2e/audio-lifecycle.test.mjs` |
| RT-1 | WHEN a realtime ticket is used, THE Node realtime boundary SHALL validate signature, tenant, session, retention, expiry, origin, and single use, and SHALL reject replay across instances. | `tests/realtime/ticket-boundary.test.mjs` |
| RT-2 | WHEN a client sends audio faster than downstream can accept it, THE realtime boundary SHALL apply a bounded queue and explicit backpressure without unbounded memory growth. | `tests/realtime/backpressure.test.mjs` |
| RT-3 | IF a socket disconnects or a chunk store/index step fails, THEN THE system SHALL reconnect or finalize through the approved fallback, record lost/orphaned chunks, and never report a complete recording silently. | `tests/e2e/realtime-recovery.test.mjs` |
| RT-4 | WHEN retained audio reaches object storage, THE system SHALL create a durable audio index before teacher playback is advertised, or SHALL expose an actionable degraded state. | `tests/e2e/teacher-audio-index.test.mjs` |

### D. Flutter product completion

| ID | Criterion | Planned automated test |
|---|---|---|
| FL-1 | WHERE locale is Sorani Kurdish or Arabic, THE app SHALL use a complete reviewed bundle, RTL layout, correct focus/semantics order, and no English fallback on critical journeys. | `apps/flutter/test/localization_coverage_test.dart`, `apps/flutter/test/rtl_journeys_test.dart` |
| FL-2 | WHEN canonical Quran text is rendered, selected, copied, or passed to practice, THE exact API bytes SHALL remain unchanged and SHALL never be normalized. | `apps/flutter/test/canonical_text_test.dart` |
| FL-3 | WHEN a learner selects a passage, THE app SHALL carry it into a listen → guided recitation → recording → correction → focused drill → completion journey without retyping numeric ranges. | `apps/flutter/test/guided_practice_journey_test.dart` |
| FL-4 | WHEN a practice completes with eligible server-derived evidence, THE app SHALL write progress once, display the resulting schedule, and remain idempotent on retry. | `apps/flutter/test/progress_write_test.dart` |
| FL-5 | WHEN a teacher later reviews a finding, THE learner SHALL be able to retrieve it from a feedback inbox/history without repeating analysis. | `apps/flutter/test/reviewed_feedback_inbox_test.dart` |
| FL-6 | WHEN a release build starts without an enrolled credential, THE app SHALL show the approved enrollment state and SHALL never embed or provision a build-time bearer token. | `apps/flutter/test/enrollment_test.dart`, `scripts/check-apk.test.mjs` |
| FL-7 | WHEN a teacher reviews a finding, THE app SHALL show session context, retained audio availability, provenance, and accept/reject/edit actions; edited text SHALL not publish the original explanation. | `apps/flutter/test/teacher_review_journey_test.dart` |
| FL-8 | WHEN a scholar approves content, THE app SHALL require source scope and risk checks, record the actor server-side, and expose the resulting audit reference. | `apps/flutter/test/scholar_approval_journey_test.dart` |
| FL-9 | IF the device goes offline, backgrounds, loses microphone permission, or disconnects, THEN THE app SHALL stop or buffer only within approved bounds, preserve consent, and show an honest recoverable state. | `apps/flutter/test/device_failure_states_test.dart` |
| FL-10 | WHEN a release candidate is proposed, THE signed Android/iOS/Web artifacts SHALL have passed the approved physical-device, OS, microphone, network, accessibility, and privacy matrix. | `tests/release/device-evidence.test.mjs` via `verify.sh --release` |

### E. Deployment, removal, and repository final state

| ID | Criterion | Planned automated test |
|---|---|---|
| OP-1 | WHEN the final local or production topology is rendered, THE only application deployables SHALL be Flutter artifacts, the Node app/worker, and the approved inference worker; React, Expo, and Rust SHALL be absent. | `tests/contract/final-topology.test.mjs` |
| OP-2 | WHEN a release is built, THE manifest SHALL bind source SHA, Flutter artifacts, Node image digests, inference artifact/model digest, SBOM, migrations, tests, and environment identity. | `tests/release/final-manifest.test.mjs` |
| OP-3 | IF the canary violates an SLO, privacy invariant, feedback gate, or data-integrity check, THEN THE deploy SHALL stop and restore the previous immutable candidate through a rehearsed rollback. | `tests/release/canary-rollback-evidence.test.mjs` |
| OP-4 | WHEN readiness is green, THE probe SHALL verify Postgres, object storage, worker capacity, and loaded ASR model; liveness SHALL remain a separate process-only signal. | `tests/observability/deep-readiness.test.mjs` |
| CL-1 | WHEN a component is retired, THE repository SHALL contain no current command, import, workflow, Compose service, release target, test, or living-document reference that executes or advertises it. | `tests/contract/retired-components.test.mjs` |
| CL-2 | WHEN cleanup completes, THE tracked source tree SHALL match the approved final tree and SHALL contain no `legacy/` copy, generated build output, secrets, virtual environment, or duplicated active specification archive. | `tests/contract/lean-tree.test.mjs` |
| CL-3 | WHEN a developer reads the README, architecture, testing, and operations documents, THE described commands and topology SHALL match executable configuration. | `tests/contract/living-docs.test.mjs` |
| CL-4 | WHEN completed historical specs are removed from the active branch, THE migration summary SHALL record their commits and unresolved decisions, while Git history remains the archive. | `tests/contract/spec-retirement.test.mjs` |
| GOV-1 | WHEN the final candidate is proposed, THE security, privacy, scholar, accessibility, mobile, SRE, and product approvals SHALL be candidate-bound, signed, and unexpired. | `tests/release/human-signoffs.test.mjs` via `verify.sh --release` |

## Success definition

The project is complete only when all criteria above are green, `bash scripts/verify.sh` and its release mode pass against the final topology, required CI checks are green, and the human approvals are attached to the exact candidate. Folder deletion, a local green run, or feature appearance alone is not completion.

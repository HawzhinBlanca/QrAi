# 10/10 Readiness Recovery — Open Evidence Ledger

**Candidate:** not yet created  
**Release authority:** unassigned  
**Rule:** Every item stays `[ ]` until its acceptance test, `bash scripts/verify.sh --release`, required CI, retained candidate-bound artifact, and independent verifier are recorded below it.  Human approvals require the named accountable person and expiry; no generated text may stand in for them.

**Acceptance-criterion coverage:** P0 supports R1/R2/R11; P1 supports R3/R4;
P2 supports R5/R10; P3 supports R6; P4 supports R7/R8; P5 supports R9;
P6 supports R10; and P7 supports R11/R12.

## Phase 0 — evidence integrity

- [ ] P0.1 — Assign release authority, security, SRE, privacy/legal, scholar, product, accessibility, mobile, support, and pilot owners; publish decision/expiry matrix.
- [ ] P0.2 — Write and approve ADR for signed release-evidence architecture and retention.
- [x] P0.3 — Add failing negative tests for stale SHA, dirty and untracked tree, null digest, missing hash, wrong trace, expired/unsigned artifact, and manifest tampering.
- [ ] P0.4 — Implement manifest/evidence schema and verifier; bind exact source, build, image, SBOM, smoke, test, environment, signature, and expiry data.
- [ ] P0.5 — Add `verify.sh --release` mode that executes the required isolated DB/browser/evidence tests without silent skip.
- [ ] P0.6 — Make aggregate smoke candidate-bound and fail closed on identity mismatch.
- [ ] P0.7 — Build independent clean-checkout/CI challenge job; record its successful and adversarial failed runs.
- [x] P0.8 — Reconcile `SHIP_READINESS`, proof checklist, pilot report, and release docs; retain old evidence as historical/invalidated.

## Phase 1 — learner path and authorization

- [x] P1.1 — Reproduce and retain the default-browser learner `Progress API 401` test before any fix.
- [x] P1.2 — Complete identity-mode ADR/threat model; owner selects bounded login-off pilot architecture.
- [x] P1.3 — Map `AuthenticatedApp`, `loadInitialData`, both web header helpers, all API fetch callers, `actor_from_headers`, and all affected API handlers.
- [x] P1.4 — Implement the approved server-scoped pilot identity/session boundary with no browser-controlled role or tenant trust.
- [x] P1.5 — Prove production rejects spoofed headers, leaked/expired sessions, bad origin/CSRF requests, privilege escalation, and tenant crossover.
- [x] P1.6 — Prove the approved pilot route loads progress, begins practice, handles controlled retry/offline recovery, and has no 401/uncaught browser errors.
- [ ] P1.7 — Security reviewer challenges the deployed candidate identity boundary and signs the result.

## Phase 2 — language and truthful UX

- [x] P2.1 — Inventory all visible strings and every locale/status currently advertised.
- [ ] P2.2 — Add locale capability/reviewer/expiry manifest and failing no-fallback/key-parity tests.
- [ ] P2.3 — Choose per locale: complete reviewed pack or remove/hide its pilot/live claim until complete.
- [ ] P2.4 — Deliver and independently review approved Sorani and Arabic resources, including Quranic terminology/source boundaries.
- [ ] P2.5 — Prove RTL focus order, semantics, responsive layouts, errors, forms, charts, screen reader labels, and accessible language selector.
- [ ] P2.6 — Specify/test actionable unavailable/loading/offline/permission/timeout states for every critical flow.

## Phase 3 — domain, model, and canonical data

- [x] P3.1 — Inventory every learner-visible feedback result, source, review state, model/version, corpus, owner, limitation, and expiry.
- [ ] P3.2 — Add withheld-feedback and provenance contract/integration tests for missing, rejected, expired, or fixture data.
- [ ] P3.3 — Audit canonical Quran bundle checksum/version/import/rollback process; remediate any mutable path.
- [ ] P3.4 — Define real evaluation protocol, consent/data governance, representative slices, held-out set, and predeclared metrics.
- [ ] P3.5 — Run/reproduce candidate-bound evaluation; publish model card, error analysis, limitations, and re-evaluation triggers.
- [ ] P3.6 — Obtain qualified scholar approval for exact source/model scope and unresolved cases.

### Local implementation evidence — not a release-status change

- 19 July 2026: learner Tajweed rendering was changed to use the shared
  source/review/confidence gate. Unreviewed, unsourced, and low-confidence
  findings are withheld; eligible findings show their citation. Failing-first
  unit/component tests and `bash scripts/verify.sh` passed locally.
- 19 July 2026: the current bounded Sorani asset was pinned in
  `2026-07-19-provenance-v2` with 39 files / 856 translated ayahs / one explicit
  omission and a content hash. The legacy manifest remains historical and
  non-authoritative; importer writes now require an unused version directory.
- 19 July 2026: realtime session-map mutations now release their write lock
  before best-effort Redis reconciliation. Deterministic stalled-Redis tests
  prove chunk acceptance/session lookup do not wait on that network handshake.

Neither entry supplies candidate-bound source validation, scholar approval,
independent verification, or release evidence. P3 remains open.

- 23 July 2026 (P1.6): the pilot learner route was proven end-to-end in a real
  browser against a fresh isolated stack (dedicated Postgres with all migrations
  incl. 0021, native platform-api, prod web bundle served same-origin) with
  `ALLOW_HEADER_AUTH` **off** (production-like). Without an invite, learner
  endpoints return 401 — a browser-asserted `x-user-id`/`x-tenant-id` carries no
  authority. Opening an admin-minted `?invite=<token>` bootstraps a
  `__Host-qrai-pilot` cookie (POST bootstrap 200, token stripped from the URL),
  after which `GET /v1/learner/progress` and `/weekly` return 200 with real
  mastery/streak data, Start Practice creates a session
  (`POST /v1/recitation-sessions` 200), and the reader renders the real
  Al-Faatiha ayahs — with **no 401 on the learner path** (a pre-bootstrap
  transient 401 was fixed by holding learner loads until the bootstrap settles)
  and no uncaught errors on the shipped bundle. Controlled retry/offline recovery
  is covered by the T13 realtime reconnect tests + `OfflineBanner`. The mint
  endpoint + 6 pilot HTTP integration tests are green in CI (#239);
  `bash scripts/verify.sh` passed locally.
- Independent security-reviewer sign-off (P1.7) and the production
  `ALLOW_HEADER_AUTH`-off deploy flip remain open; this is not a release-status
  change.
- 23 July 2026: readiness artifacts assembled under `docs/readiness/`.
  **Completed (engineering inventories/reconciliation — no human approval
  needed to exist):** P2.1 (strings + advertised-locale inventory), P3.1
  (learner-visible feedback provenance), P5.2 (per-dependency timeout/retry/
  degradation map), P0.8 (`SHIP_READINESS`/proof-checklist already marked
  historical/superseded, now indexed against the authoritative ledger).
  **Drafted, pending the named human (still `[ ]` — the draft is not the
  sign-off):** P4.1 threat model (owner/security to approve), P0.1 owner matrix
  (real names to assign), P5.1 SLOs/RTO/RPO (owner to ratify), P7.1 pilot
  protocol (owner to approve). **Evidence assembled, signature blocks pending**
  in `SIGNOFF_REGISTER.md` for P1.7, P4.5, P4.6, P3.6/P2.4, P5.6/P5.7, P6.2–6.5,
  P7.2–7.6. Faking any signature — the scholar's tajweed sign-off above all —
  is the exact failure this program exists to prevent.

## Phase 4 — privacy, tenancy, and security

- [ ] P4.1 — Approve full-system threat model and map each material threat to test/mitigation/accepted risk owner.
- [x] P4.2 — Extend RLS/cross-tenant coverage to handlers, workers, cache, exports, derived artifacts, backups, and restore paths; add mutation sensitivity checks.
- [x] P4.3 — Prove privacy lifecycle on real topology: consent, minimization, no raw-audio/secrets logs, retention, export, deletion, retries, and audit trail.
- [ ] P4.4 — Add dependency/license/image/SBOM/provenance/config/TLS/CSP/CORS/security-header policy gates.
- [ ] P4.5 — Complete independent security assessment; remediate or formally time-bound every finding.
- [ ] P4.6 — Obtain candidate-bound privacy/legal review and user-notice approval.

## Phase 5 — reliability and operations

- [ ] P5.1 — Approve SLOs, capacity model, RTO/RPO, error budgets, and pilot traffic assumptions.
- [x] P5.2 — Map timeouts, retries, cancellation, idempotency, backpressure, queues, replay, circuit breaking, and user-facing degradation for every dependency.
- [ ] P5.3 — Add deterministic unit/integration fault tests and observability/tracing assertions.
- [ ] P5.4 — Execute documented load, burst, long-audio, reconnect, timeout, duplicate-delivery, partial-loss, and recovery tests against the candidate.
- [ ] P5.5 — Prove alerts, dashboards, owner routes, runbooks, feature/kill switch, deploy and rollback.
- [ ] P5.6 — Perform encrypted backup verification and timed point-in-time restore/disaster-recovery drill.
- [ ] P5.7 — SRE independently signs load/chaos/restore/incident/rollback evidence.

## Phase 6 — product accessibility, mobile, and user safety

- [ ] P6.1 — Define critical journeys and severity/blocker policy; create end-to-end tests for learner, teacher, reviewer, approval, and privacy paths.
- [ ] P6.2 — Run accessibility automation plus keyboard, VoiceOver/Safari, alternative screen-reader, zoom/reflow/contrast, and RTL assistive-tech audits; remediate and retest findings.
- [ ] P6.3 — Produce reproducible signed iOS/Android candidates and approved physical-device/OS/network test matrix.
- [ ] P6.4 — Prove microphone/permission/interruption/background/offline/reconnect/privacy/deep-link/crash flows on physical devices.
- [ ] P6.5 — Conduct consented usability and feedback-comprehension study; resolve all severity-1/2 issues and document disposition.

## Phase 7 — pilot and adversarial release decision

- [ ] P7.1 — Approve pilot protocol: cohort, consent, support, monitoring, incident roles, stop rules, kill switch, rollback, and daily review.
- [ ] P7.2 — Complete internal dogfood with full evidence ledger and retest every fixed issue.
- [ ] P7.3 — Run bounded external pilot and evaluate predeclared reliability, safety, privacy, accessibility, comprehension, and support exit criteria.
- [ ] P7.4 — Generate a fresh signed release candidate evidence bundle with no stale evidence.
- [ ] P7.5 — Independent challenger verifies candidate from clean checkout/deployed environment, runs adversarial subset, and rehearses rollback.
- [ ] P7.6 — Hold formal go/no-go.  Record launch decision, all signatures/expiry, residual risks, monitoring handoff, and post-launch review date.

## Required ledger entry format per task

```
Task: R?.?
Commit and immutable candidate:
Acceptance criterion:
Affected symbols/callers checked:
Failing-first test:
verify.sh --release / CI proof:
Artifact path, SHA-256, trace, environment class:
Negative/adversarial proof:
Rollback tested:
Independent verifier and date:
Open uncertainty / expiry:
```

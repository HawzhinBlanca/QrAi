# Plan: Number-One Release Program

**Approved-by:** Hawzhin  
**Release owner:** Hawzhin  
**Candidate SHA:** 6e4908c3191a16baf1524f8b67df962ac0bf5911

## Operating rules for all agents

1. Work on one numbered task only; write a failing test first where code is
   involved.
2. Re-run `bash scripts/verify.sh` after every task. A green result is a
   minimum check, not permission to claim release readiness.
3. Do not mutate canonical Quran data, bypass RLS, re-enable general-user login
   without owner approval, expose secrets, or make hand-authored model claims.
4. Attach raw command output, artifact paths, SHA, environment, and trace ID to
   the task ledger. A task without reproducible evidence stays open.
5. Stop at each human-gated task. Agents may prepare a packet; they cannot
   manufacture scholar, legal, security, or product approval.

## Phase 0 — Freeze the candidate and prove the proof system

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 0.1 Reconcile every current change into reviewed commits or explicitly discard it. | Release agent | Clean branch + release manifest | `git diff --exit-code`; signed SHA; CI run links. |
| 0.2 Make protected CI execute all required quality gates. | CI agent + repo owner | Required-check policy; CI changes | Fresh PR proves `verify`, golden regression, DB migration list, web non-root assertion, and vulnerability scan run. |
| 0.3 Make stale evidence impossible to reuse. | Release agent | Machine-readable manifest | Manifest binds SHA, image digests, environment, timestamps, trace IDs, and artifact hashes; verifier reruns it from a clean checkout. |
| 0.4 Establish a disposable staging environment. | Platform agent + owner | IaC/config runbook | Recreate from zero; no default secrets; destroy/recreate succeeds. |

**Gate P0:** an independent agent clones the SHA into a fresh directory and
reproduces all non-live checks without local state.

## Phase 1 — Correctness before features

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 1.1 Produce the scholar rule packet and hold a recorded review. | Domain agent + qualified scholar | Rule-by-rule scope matrix, signed decision | Scholar marks each rule approve/disable/fix; UI and contract tests match decision. |
| 1.2 Keep withheld rules impossible to surface as feedback. | Domain agent | Contract/UI regression tests | Mutation test attempts to show unreviewed/unsourced output and fails closed. |
| 1.3 Validate canonical Quran data independently. | Data agent + independent reviewer | Two-source reconciliation report | All 114 surahs, ayah/word totals, source hashes, and version manifest reproduce independently. |
| 1.4 Establish a real evaluation methodology. | ML agent + teacher panel | Frozen labeled holdout and rubric | Blinded teacher agreement, precision/recall by rule, calibration, confidence intervals, demographic/language slices; no fixture-only claim. |
| 1.5 Keep neural Tajweed outside learner paths until separately approved. | ML agent | Runtime guard + deployment policy | Attempted enablement without approval is rejected in CI/staging. |

**Gate P1:** no learner-facing religious claim exceeds the signed scope; all
unapproved output is structurally blocked, not merely relabeled.

## Phase 2 — Security, tenancy, and privacy under attack

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 2.1 Run every ignored platform-api integration test against real Postgres. | Backend agent | DB-backed CI job | 47 tests run—not skipped—using the restricted non-BYPASSRLS role. |
| 2.2 Add adversarial two-tenant RLS coverage for every table and object key. | Security agent | Tenant attack suite | Tenant A cannot enumerate, read, modify, export, review, or delete Tenant B data through API, SQL, direct object access, or background jobs. |
| 2.3 Validate auth/session/realtime boundaries. | Security agent | Negative test matrix | Expired, replayed, forged, cross-tenant, cross-role, malformed, and origin-violating requests all fail closed. |
| 2.4 Prove consent, retention, export, and deletion. | Privacy agent | Data-lifecycle E2E artifact | Before/after DB rows, object blobs, audit events, export manifest, and deletion receipt align for each retention mode. |
| 2.5 Commission independent security review. | Owner + external reviewer | Threat model and findings report | All critical/high findings fixed and retested; remaining risk explicitly accepted by owner. |

**Gate P2:** a hostile tester with valid credentials for one tenant cannot
obtain another tenant's audio, metadata, reviews, or exports.

## Phase 3 — Make the core journey boringly reliable

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 3.1 Implement/repair the complete learner-to-teacher vertical slice. | Web + backend agents | E2E scenario | Login (production only), consent, record, upload, alignment, gated result, submission, teacher decision, learner refresh. |
| 3.2 Cover failure and recovery states. | Web agent | State matrix | API, ML, ASR, gateway, DB, mic denied/unavailable, timeout, reconnect, and duplicate-submit cases produce truthful copy and recovery. |
| 3.3 Prove role-specific surfaces. | Web + backend agents | Role E2E suite | Learner, teacher, scholar, and admin access only authorized routes and data. |
| 3.4 Test privacy journey in-browser. | Web + privacy agents | Browser evidence | Export contains only the acting learner; deletion is confirmed and irrecoverable for that learner only. |
| 3.5 Validate all real navigation paths. | Product QA agent | Screenshot/video+DOM matrix | No hidden production route, dead end, placeholder, or false success state in the supported journey. |

**Gate P3:** one trace ID links every step across browser, API, gateway, ML,
database, audit events, and privacy artifacts; the full journey passes three
times on clean staging data.

## Phase 4 — Human-quality UX, accessibility, language, and mobile

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 4.1 Conduct task-based accessibility testing. | Accessibility specialist | WCAG issue register | Keyboard-only, NVDA/VoiceOver, zoom/reflow, focus order, errors, and motion tested on the core journey; zero critical blockers. |
| 4.2 Implement and validate RTL. | Web + native-speaker QA | RTL visual suite | Arabic, Sorani, and Urdu directionality, Quran text handling, focus order, and overflow verified at supported widths. |
| 4.3 Ship reviewed languages, not a misleading picker. | Localization owner + scholar/native reviewers | Locale release pack | Pilot-language copy approved; unavailable languages are clearly absent or labeled, never silently pretended localized. |
| 4.4 Prove real-device mobile. | Mobile agent + QA | Device matrix | Supported iOS/Android versions complete auth, consent, recording, interruption, background/foreground, upload, review, export/delete. |
| 4.5 Pilot the teacher workflow. | Product + teacher panel | Usability report | Time-to-review, clarity, error recovery, and agreement targets met with real users; fixes validated. |

**Gate P4:** no critical accessibility, localization, or device blocker remains
in the supported pilot journey.

## Phase 5 — Production operations and resilience

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 5.1 Harden build and supply chain. | DevSecOps agent | SBOM, image scan, signatures | All images non-root; high/critical vulnerabilities triaged; provenance and digest pinning verified. |
| 5.2 Provision production posture. | Platform owner | TLS, secrets, restricted DB role | TLS/HSTS, secret-manager injection, no insecure flags, backups, restore tested, least-privilege service accounts. |
| 5.3 Instrument SLOs. | SRE agent | Dashboards and alerts | Availability, p95 latency, error rate, queue depth, auth failures, RLS denials, deletion failures, and model drift alert correctly. |
| 5.4 Load, soak, and chaos test staging. | SRE + backend agents | Raw results and capacity model | Approved p95/p99/error budget under peak, sustained, and dependency-loss scenarios; no data loss or cross-tenant leak. |
| 5.5 Rehearse incident and rollback. | Release owner + on-call | Game-day report | Restore backup, rotate compromised secret, disable faulty feedback rule, roll back deployment, and communicate incident within target times. |

**Gate P5:** the system survives a service failure and a restore drill without
loss of integrity, confidentiality, or truthful learner communication.

## Phase 6 — Independent release challenge

| Task | Owner | Deliverable | Exit proof |
|---|---|---|---|
| 6.1 Fresh-environment verification. | Independent release agent | Reproduction report | Starting from SHA + documented secrets/IaC, reproduce P0–P5 artifacts. |
| 6.2 Red-team day. | Security/product/domain reviewers | Challenge log | Attack tenant boundaries, consent, replay, error states, accessibility, localization, and religious-claim scope. |
| 6.3 Go/no-go council. | Owner, scholar, legal, security, SRE, product | Signed decision | Every R1–R11 item has an artifact and accountable sign-off; rejected risks block launch. |
| 6.4 Canary and monitored launch. | Release + SRE | Canary report | Gradual exposure, objective rollback thresholds, daily review, and no unresolved severity-1/2 incident. |

## Toughest proof package

Require agents to deliver these, not prose:

1. A clean-clone, commit-bound evidence manifest whose hashes are independently
   verified.
2. A three-tenant hostile E2E run with retained audio, export/delete, teacher
   review, replayed WebSocket ticket, and direct SQL/object-store denial proofs.
3. A recorded, trace-linked learner journey that survives forced ML, ASR,
   gateway, database, and network failure—without false success copy.
4. A scholar-signed Tajweed scope matrix and blind teacher-agreement evaluation
   on a held-out, versioned dataset.
5. A staging load/soak/chaos report with raw time series, capacity limits, and
   a successful restore/rollback game day.
6. A real-device accessibility and RTL evidence pack, reviewed by people who
   use the supported languages and assistive technologies.

## Stop condition

Do not begin implementation from this plan until `Approved-by` is filled in.
No agent may mark the program complete; only the Phase 6 council can issue the
go/no-go decision.

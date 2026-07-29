# Specification: 10/10 Readiness Recovery

## Status

**Approved-by:** ____________________  
**Approval date:** ____________________  
**Release authority:** ____________________

This specification starts only after the owner approves this recovery program.
It replaces no historical evidence and authorizes no production launch by
itself.

## Acceptance criteria and proof mapping

| ID | EARS acceptance criterion | Automated proof required inside `scripts/verify.sh` | Independent / human proof |
| --- | --- | --- | --- |
| R1 | WHEN a release candidate is created, THE system SHALL produce a signed evidence manifest bound to one clean commit, all deployable artifact digests, SBOMs, test artifacts, trace IDs, environment class, and expiry. | Manifest schema, clean-tree, SHA, digest, hash, signature, and expiry verifier tests. | Release engineer verifies a fresh candidate from a separate checkout. |
| R2 | WHEN a proof artifact belongs to another commit, is missing, expired, unsigned, or has a null deployable digest, THE release gate SHALL fail. | Negative fixture matrix for each invalid condition. | Independent reviewer records the failed challenge. |
| R3 | WHEN the default no-login pilot web journey loads, THE learner SHALL receive authorized progress and complete practice without a 401, console error, or hidden test-mode shortcut. | Real-browser E2E through an isolated API/Postgres stack; negative assertion on console/network errors. | Release QA repeats against the candidate environment. |
| R4 | WHEN production identity policy is active, THE API SHALL reject spoofed identity headers and cross-tenant access; WHEN the approved pilot policy is active, THE browser SHALL receive only the server-scoped pilot identity. | Auth/session, CORS, cookie, RLS, role, and cross-tenant tests in both policy modes. | Security reviewer approves threat model and ADR. |
| R5 | WHEN a language is offered as `pilot` or `live`, THE product SHALL render its reviewed resources rather than English fallbacks, preserve reading direction, and expose accessible language names. | Key-completeness, no-fallback, RTL visual/semantic, and language-selector tests. | Native-language and Quran-content reviewer signoff. |
| R6 | WHEN a learner receives alignment or tajweed feedback, THE product SHALL expose only real or declared-fixture results that include source, review/approval status, model/version provenance, and clear uncertainty. | Contract/integration/evaluation provenance tests and red-team fixtures proving withheld feedback remains withheld. | Qualified scholar/evaluation owner signs current model card and corpus report. |
| R7 | WHEN tenant-owned, audio, privacy, or account data is read, written, exported, or deleted, THE system SHALL enforce RLS, authorization, consent, retention, and auditable completion without logging raw audio or secrets. | Cross-tenant/RLS, privacy export/delete, retention, log-redaction, and error-path tests. | Privacy/legal owner validates the real data flow and notices. |
| R8 | WHEN dependencies, builds, deployment configuration, or public endpoints change, THE delivery system SHALL prevent known-critical vulnerabilities, unsigned artifacts, unsafe configuration, and unreviewed production changes. | Dependency/license/SBOM policy, config lint, image scan policy, signature, CSP/CORS/TLS, and deployment-policy tests. | Independent penetration test and security release signoff. |
| R9 | WHEN a service, dependency, network, or client reconnect fails within the approved fault model, THE platform SHALL degrade safely, preserve tenant boundaries, recover or fail visibly, and emit traceable telemetry. | Deterministic timeout/retry/idempotency/reconnect/fault-injection tests plus SLO-budget checks. | SRE validates load, chaos, backup-restore, and incident drill reports. |
| R10 | WHEN a learner, teacher, reviewer, keyboard-only user, screen-reader user, or supported mobile-device user completes a critical journey, THE product SHALL complete the approved journey with understandable recovery, accessible controls, and no severity-1 or severity-2 usability defect. | Browser/mobile critical-path and automated accessibility regression suite. | Scripted expert accessibility and device matrix review; signed defect disposition. |
| R11 | WHEN a release is proposed, THE release gate SHALL block promotion unless all required current evidence, owner approvals, rollback rehearsal, monitoring, support readiness, and pilot exit criteria are present. | Evidence-policy test fixture matrix and promotion-gate integration test. | Change advisory/release authority signs go/no-go record. |
| R12 | WHEN an approved pilot is running, THE organization SHALL measure consented outcomes and safety signals, respond through an on-call process, and halt or roll back within the approved limit if a stop condition is met. | Telemetry schema, alert-routing, kill-switch, and rollback automation tests. | Pilot owner, scholar, privacy, and support leads sign pilot and exit reports. |

## Completion definition

The program is complete only when R1–R12 are green on the *same immutable
candidate*, all listed human gates are current and signed, no release-blocking
finding is open, and an independent challenger can reproduce the verdict.
“All boxes checked” in a planning file is explicitly not completion.

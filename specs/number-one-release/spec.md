# Specification: Number-One Release Program

## Objective

Deliver one release candidate whose core learner-to-teacher-to-privacy loop is
correct, secure, usable, observable, and independently reproducible. “Number
one” means no known material claim is unproven; it does not mean a subjective
marketing ranking.

## Acceptance criteria (EARS)

| ID | Criterion | Required automated proof |
|---|---|---|
| R1 | WHEN a release candidate is proposed, THE system SHALL identify one clean commit SHA and reject evidence from a dirty tree. | CI release-manifest test plus `git diff --exit-code` in release workflow. |
| R2 | WHEN any tenant-owned API path is exercised, THE system SHALL enforce Postgres RLS with the restricted application role. | Live multi-tenant integration suite plus object-storage isolation test. |
| R3 | WHEN a learner records a permitted recitation, THE system SHALL persist, align, gate, and display only sourced/review-authorized feedback. | Trace-linked browser/API/gateway/ML E2E test. |
| R4 | WHEN a learner has not consented, THE system SHALL prevent external ASR processing and make export/delete results attributable to that learner only. | Live privacy E2E test with retained-audio object-store assertions. |
| R5 | WHEN a service, microphone, or network fails, THE system SHALL preserve truthful state, provide a usable recovery action, and make no false completion claim. | Browser failure-state matrix at desktop and mobile widths. |
| R6 | WHEN a teacher reviews a submitted session, THE system SHALL show only tenant-authorized data and record a durable, attributable decision. | Live two-tenant teacher-review E2E test. |
| R7 | WHEN Tajweed feedback is exposed, THE system SHALL stay within scholar-approved rule scope and label any non-approved output as unavailable to learners. | Scholar-signed rule matrix checked against contract/UI test fixtures. |
| R8 | WHEN the web app is used by keyboard, screen reader, or RTL language readers, THE system SHALL support task completion without a critical blocker. | Automated axe gate plus recorded manual accessibility protocol and RTL visual regression. |
| R9 | WHEN production infrastructure starts, THE system SHALL refuse insecure secrets, use TLS, run all images non-root, expose health/metrics, and restore from a tested backup. | Staging deployment, image-policy scan, synthetic monitor, and restore drill. |
| R10 | WHEN a mobile learner completes the primary flow, THE system SHALL prove the same consent/auth/record/review behavior on supported physical devices. | Device-farm or recorded real-device E2E matrix. |
| R11 | WHEN release load is applied, THE system SHALL meet approved latency/error/SLO thresholds without tenant leakage, unbounded queues, or unhandled retries. | Staging load/soak/chaos report with raw metrics and pass/fail exit status. |

## Release rule

No R1–R11 criterion may be marked complete without its named proof, a linked
artifact, and an approver. A red, skipped, stale, mock-only, or manually
edited artifact is a release blocker.

# Consent, Retention, Export, and Deletion Lifecycle Plan

Create a script `scripts/privacy-audit-run.mjs` to execute E2E data-lifecycle checks against the staging environment, asserting that before/after DB rows, audio blobs, and audit events match perfectly for each retention mode, and generate the required E2E proof artifact.

## User Review Required

> [!IMPORTANT]
> The audit script will interact with the running staging services (`platform-api` on localhost:8080 and `ml-inference` on localhost:8090) and the staging database on port 5433 to collect real proof.

## Proposed Changes

### Automation & Scripting

#### [NEW] [privacy-audit-run.mjs](file:///Users/hawzhin/QrAi/scripts/privacy-audit-run.mjs)
- Implement a Node.js script that:
  - Connects to staging DB via pg/sqlx (using the restricted user credentials).
  - Simulates the recitation journey for a learner with `discard` retention mode.
  - Simulates the recitation journey for a learner with `teacher-review` retention mode.
  - Verifies before/after DB rows, audio blobs on disk (via ML service query), audit events, export manifest, and deletion receipt.
  - Formats and writes the output as a Markdown artifact `privacy_data_lifecycle_proof.md` in the Antigravity artifact directory.

## Verification Plan

### Automated Tests
- Run the audit script:
  ```bash
  node scripts/privacy-audit-run.mjs
  ```
- Run the verify script:
  ```bash
  bash scripts/verify.sh
  ```

# Documentation Truth Cleanup — Specification

## Acceptance criteria

- **D1:** WHEN a reader consults active architecture, privacy, or onboarding
  documentation, THE document SHALL describe the implemented structured
  `agent_runs` erasure path without claiming that the removed gap is open.
- **D2:** WHEN a reader consults a superseded planning document, THE document
  SHALL identify itself as historical and point to the current readiness ledger.
- **D3:** WHEN a reader follows the external-data licensing rule, THE active
  license inventory SHALL be self-contained and SHALL NOT depend on a
  superseded roadmap for its governing rule.
- **D4:** WHEN the documentation cleanup is complete, THE existing behavior
  proofs and `bash scripts/verify.sh` SHALL remain green; no readiness or human
  approval status SHALL be upgraded.

## Proof mapping

| Criterion | Proof |
|---|---|
| D1 | Existing `privacy_delete_erases_learner_agent_runs` integration test and `bash scripts/verify.sh` |
| D2 | Focused diff review against `specs/readiness-recovery-10-10/tasks.md` P0.8; `bash scripts/verify.sh` |
| D3 | Focused diff review of `docs/DATA_LICENSES.md`; `bash scripts/verify.sh` |
| D4 | `bash scripts/verify.sh` |

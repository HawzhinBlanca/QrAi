# Documentation Truth Cleanup — Research

## Scope

Remove ambiguity from active documentation and clearly classify stale planning
documents. Historical release evidence must be retained, not deleted, because
the readiness ledger explicitly requires historical/invalidated evidence to
remain inspectable.

## Authoritative current records

- `specs/readiness-recovery-10-10/tasks.md` is the sole readiness record for a
  new candidate; `docs/readiness/README.md` indexes its supporting artifacts.
- `docs/readiness/TRUE_READINESS.md` is the readable current-status summary,
  but its verification claim must be refreshed only from a successful current
  gate.

## Current documents requiring factual correction

- `README.md` still describes mocked partial alignment, a first Axum API, no
  SQLx/Postgres repositories, and local RBAC headers as the active boundary.
- `docs/DATA_INVENTORY.md` says learner-linked `agent_runs` cannot be erased.
- `docs/architecture/10-10-platform.md` repeats the same false erasure gap and
  an obsolete migration requirement.
- Reality: migration `0018_agent_run_learner_id.sql`, `agent.rs` writer/listing,
  `privacy.rs` export/delete queries, and the live integration test
  `privacy_delete_erases_learner_agent_runs` now cover structured learner-linked
  agent runs. Null/unstructured historical data must not be claimed erased.

## Historical documents to retain but label

- `docs/SHIP_READINESS.md` is already correctly marked historical/superseded.
- `docs/SHIP_PLAN.md`, `docs/ROAD_TO_1_TASKS.md`,
  `docs/10-10-true-implementation-plan.md`, and
  `docs/superpowers/plans/2026-06-25-full-platform-ship-ready.md` contain stale
  implementation states and should gain a uniform historical banner pointing
  to the recovery ledger, rather than being deleted.
- `docs/DATA_LICENSES.md` and several ADRs cite old documents as historical
  context; moving or deleting them would break traceability and links.

## Integration points and risks

- Documentation is published through repository paths; there is no generated
  docs build to update. Markdown links and current commands must be checked.
- Correcting privacy wording must preserve lawyer/DPO open decisions (age,
  retention, guardian verification) and must not turn code coverage into legal
  approval.
- No readiness status, human sign-off, smoke artifact, or release claim may be
  upgraded during this cleanup.

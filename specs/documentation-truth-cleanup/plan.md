# Documentation Truth Cleanup — Plan

**Approved-by:** User approval in Codex task, 2026-07-25

## T1 — Correct active documentation

Update `README.md`, `docs/DATA_INVENTORY.md`, and
`docs/architecture/10-10-platform.md` from the present code and existing live
integration proof. State that privacy export/delete covers **structured,
learner-linked** agent runs; do not overclaim deletion of unstructured legacy
data or convert engineering proof into legal approval.

## T2 — Classify, do not erase, historical plans

Add a uniform historical/superseded banner to `SHIP_PLAN`, `ROAD_TO_1_TASKS`,
the prior 10/10 plan, and the 2026-06-25 superpowers plan. Each banner points to
`specs/readiness-recovery-10-10/tasks.md`. Keep `SHIP_READINESS` unchanged: it
already has the correct banner. Make `DATA_LICENSES` self-contained instead of
linking its governing rule to the superseded roadmap.

## Guardrails

- Do not delete, move, or rewrite historical evidence; P0.8 requires retention.
- Do not change the readiness ledger, sign-off register, or current readiness
  claims as part of this cleanup.
- Do not add a prose-string test: the existing integration proof verifies the
  behavior; a phrase guard would make factual documentation brittle.

## Verification

After each task, run `bash scripts/verify.sh` and use
`scripts/update-ledger.sh` only for the local task ledger after it is green.

## Stop condition

Do not implement until a human fills the `Approved-by:` line above.

## Completion evidence

- 2026-07-25: T1 corrected active product, privacy-inventory, and architecture
  documentation to describe structured learner-linked agent runs accurately.
- Proof: the canonical verification gate completed successfully, including the
  live Postgres integration test `privacy_delete_erases_learner_agent_runs`
  among 76 platform-api integration tests.
- 2026-07-25: T2 retained all four prior planning documents but added a uniform
  historical boundary that directs release decisions to the current readiness
  ledger; `DATA_LICENSES.md` now states its registration rule directly.

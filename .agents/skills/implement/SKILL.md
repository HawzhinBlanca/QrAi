---
name: implement
description: Phase 3 of the CODYSTEM loop. Implement ONE approved task test-first via Serena symbolic edits, run scripts/verify.sh, and flip the ledger only if it exits 0. Requires an approved plan.md. Never marks done by judgment.
---

# Implement (one task, then prove it)

**Precondition:** `plan.md` has a filled-in `Approved-by:` line. If it does not, STOP — run
`plan` and wait for human approval first.

## Procedure

Plan approved. Implement only task `T1` from `tasks.md` — smallest correct change,
test-first. Edit via Serena symbolic edits. Then run `bash scripts/verify.sh`. If it exits
0, run `scripts/update-ledger.sh T1 t-ac1`. If it fails, fix and re-run; do NOT mark done
until green. Keep context under 50%; compact progress into `plan.md` before the next task.

(Repeat per task: `T2`, `T3`, … each with its own test IDs.)

## Anti-cheat (these are violations, not shortcuts)
- Do not skip/disable/delete tests, or use `.only` / `xit` / `skip` / `@Disabled`.
- Do not weaken assertions, mock the thing under test, or edit a test to match buggy output.
- Do not use `--no-verify`, or edit CI / hooks / guard scripts to force green.
- Never mark a task done from memory. Only `update-ledger.sh` (after verify passes) flips it.

## Done when
- `bash scripts/verify.sh` exits 0 (full log ends `VERIFY OK`).
- `scripts/update-ledger.sh <TASK> <TESTS>` flipped the row because verify passed.
- Required CI checks are green on the PR (the real source of truth).

→ Next: `review` (run with a different model for independent judgment of the diff).

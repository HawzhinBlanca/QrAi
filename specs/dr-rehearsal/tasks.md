# Tasks — deploy, rollback, and restore rehearsal

Plan: `plan.md` (APPROVED 2026-07-30). Rows flip ONLY via `scripts/update-ledger.sh` after
`verify.sh` exits 0 **and** the task's stated acceptance is met.

## Outcome after the Docker restart: 2 of 5 closed (T1, T3). T2/T4/T5 remain open.

**First attempt was BLOCKED** — the Docker daemon died mid-attempt and Docker Desktop reinitialized
its VM on restart, taking the staging stack's containers, images and volumes with it. That record is
kept in `evidence/T1-drill-BLOCKED.md` rather than deleted: it is what actually happened, and the
incident landed squarely on the gap this phase exists to close.

**After the restart the drills ran for real:**

| Drill | Result | Evidence |
|---|---|---|
| **T1** restore | **PASS** — full corpus restored, all counts matched source, `<1s` | `evidence/T1-restore-drill.log` |
| **T3** kill-switch | **PASS** — app routes 503, health/ready/metrics 200, control confirms | `evidence/T3-killswitch-drill.log` |
| **T2** audio volume | **PASS** — pre-erasure backup restored; erased audio did NOT come back, control did | `evidence/T2-audio-drill.log` |
| T4 rollback | **still impossible** — no artifact exists (ADR-0022 unresolved) | — |
| T5 runbook | partially closed — T1/T3 numbers filled in, rollback still UNMEASURED | — |

The principle still holds for what did NOT run: **delivering a script is not the same as proving
recovery works.** T4 has analysis but no drill, so its row stays open.

T2 closed on 2 August 2026 by a drill that used the real components rather than fixtures:
ml-inference stored the chunks through its own audio path, platform-api's real
`POST /v1/privacy/delete` erased them and wrote `privacy_jobs`, and the two committed scripts did
the backup and the restore. A second learner's file is the control — without one, "the erased file
is absent" is also true of a restore that restored nothing.

- [x] T1 restore script + timed drill — DONE, drill PASSED with controls
- [ ] T2 audio-volume round trip + erasure re-application — drill PASSED, awaiting verify.sh + CI
- [x] T3 kill-switch drill — DONE (native binary over real HTTP, not compose — stated in the log)
- [ ] T4 rollback artifact — **ADR written (proposed), rehearsal BLOCKED**
- [ ] T5 runbook sections — T1/T3 numbers now measured and filled in; rollback still UNMEASURED, so not closed

---

## What was actually delivered, and is in the gate

| Artifact | State |
|---|---|
| `scripts/restore-db.sh` | **Drill-proven.** Refuses a non-empty target without `RESTORE_FORCE=1` (confirmed: exit 3 against a populated DB); **no default target**; row-count verification confirmed to FAIL on an under-restored database (`FAIL canonical_ayahs expected 6236, got 7`, exit 1). Timer resolution fixed after the drill showed `0s`, which is not a usable number. |
| `scripts/restore-db.test.sh` | **5/5 green, wired into `verify.sh`.** Covers the pre-connection guards, including a source-level assertion that a `DATABASE_URL` fallback can never be reintroduced |
| `docs/DECISIONS.md` ADR-0022 | The T4 blocker analysed, three options, recommendation. **Status: Proposed** — the owner picks (A) local tags or (B) registry |
| `docs/STAGING_RUNBOOK.md` | Take-down / rollback / restore / bring-up. Closes the dangling `alerts.yml` → runbook reference. T1/T3 timings now **measured**; rollback still reads UNMEASURED because it genuinely is |
| `evidence/T1-drill-BLOCKED.md` | The first, blocked attempt — **kept, not deleted.** It is what happened, and the daemon crash it records is itself the incident this phase exists to prepare for |
| `evidence/T1-restore-drill.log` | The real drill: backup → restore → verify, both guards exercised, plus a correction of my own piping error that had masked an exit code |
| `evidence/T3-killswitch-drill.log` | Kill-switch over real HTTP, with the control run that makes the 503s meaningful |

### The safety rule that is proven

`verify.sh:28` exports a default `DATABASE_URL` pointing at a real local database. A restore script
falling back to it would overwrite a developer's own data during what they believed was a drill.
`restore-db.sh` therefore takes a **separate, required** `RESTORE_TARGET_URL` with no fallback, and
the test asserts both the runtime refusal and the absence of any fallback in the source.

This is the one part of Phase 4 that is genuinely proven, and it is proven because it needs no
database to prove.

---

## Why T5 still does not close

`plan.md` T5 required *"every command in the new sections was actually executed in a T1–T4 drill."*
The restore and kill-switch sections now meet that bar. **The rollback section does not** — it cannot,
because there is nothing to roll back to (ADR-0022). Its timing still reads UNMEASURED rather than
carrying an invented number, so the task stays open.

---

## To finish this phase

Needs a host with a working Docker daemon, or two reachable Postgres instances. The exact commands
are in `evidence/T1-drill-BLOCKED.md`. Then:

1. ~~T1 restore drill~~ **done, PASS.**
2. ~~T3 kill-switch drill~~ **done, PASS.**
3. **T2** audio-volume round trip — needs the `audio_storage` volume and the erasure re-application
   step. Not started.
4. **T4** needs the owner's ADR-0022 decision **before** rehearsal — rehearsing rollback today would
   rehearse a rebuild, which is the wrong thing to practise.
5. **T5** closes when T4's rollback timing replaces the last UNMEASURED marker.

Still human afterwards regardless: **P5.7** (SRE signs the evidence), **P7.5** (independent
challenger rehearses rollback), **P5.1** (RTO/RPO ratified — I can measure recovery time, but whether
it is acceptable is a business decision), and backup **encryption**, which P5.6 requires and
`backup-db.sh` does not do.

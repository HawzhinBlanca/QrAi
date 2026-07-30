# Tasks — deploy, rollback, and restore rehearsal

Plan: `plan.md` (APPROVED 2026-07-30). Rows flip ONLY via `scripts/update-ledger.sh` after
`verify.sh` exits 0 **and** the task's stated acceptance is met.

## ⚠️ Outcome: 0 of 5 tasks closed. Every acceptance criterion required a drill; no drill ran.

The Docker daemon on this host cannot start new containers (evidence:
`evidence/T1-drill-BLOCKED.md`). `psql`/`pg_dump` are not on PATH either — earlier work reached
Postgres through a `docker exec` shim, which the same failure removes. There is no route to a
database from here.

Real work was delivered and is gated (below), but **delivering a script is not the same as proving
recovery works**, and that inference is exactly what this project has been burned by before. So no
row is flipped and no ledger item is claimed.

- [ ] T1 restore script + timed drill — **script DONE, drill BLOCKED**
- [ ] T2 audio-volume round trip + erasure re-application — **BLOCKED, not started**
- [ ] T3 kill-switch drill through the real stack — **BLOCKED**
- [ ] T4 rollback artifact — **ADR written (proposed), rehearsal BLOCKED**
- [ ] T5 runbook sections — **written, but with UNMEASURED markers, so acceptance not met**

---

## What was actually delivered, and is in the gate

| Artifact | State |
|---|---|
| `scripts/restore-db.sh` | Written. Refuses a non-empty target without `RESTORE_FORCE=1`; **no default target**; verifies row counts after restore; prints measured elapsed time. **Never executed against a live database.** |
| `scripts/restore-db.test.sh` | **5/5 green, wired into `verify.sh`.** Covers the pre-connection guards, including a source-level assertion that a `DATABASE_URL` fallback can never be reintroduced |
| `docs/DECISIONS.md` ADR-0022 | The T4 blocker analysed, three options, recommendation. **Status: Proposed** — the owner picks (A) local tags or (B) registry |
| `docs/STAGING_RUNBOOK.md` | Take-down / rollback / restore / bring-up sections. Closes the dangling `alerts.yml` → runbook reference. Timings marked **UNMEASURED**, never estimated |
| `evidence/T1-drill-BLOCKED.md` | The absence of a drill, recorded rather than left to be inferred from silence |

### The safety rule that is proven

`verify.sh:28` exports a default `DATABASE_URL` pointing at a real local database. A restore script
falling back to it would overwrite a developer's own data during what they believed was a drill.
`restore-db.sh` therefore takes a **separate, required** `RESTORE_TARGET_URL` with no fallback, and
the test asserts both the runtime refusal and the absence of any fallback in the source.

This is the one part of Phase 4 that is genuinely proven, and it is proven because it needs no
database to prove.

---

## Why T5 does not close despite being written

`plan.md` T5 required *"every command in the new sections was actually executed in a T1–T4 drill; no
step is written from assumption."* The sections are written from the code and the scripts, not from a
rehearsal. Writing plausible timings would have satisfied the letter of the task and defeated its
purpose — a number nobody measured is worse than no number, because it gets planned against.

Every timing therefore reads **UNMEASURED**, and the runbook ends with an explicit statement that it
is not evidence recovery works.

---

## To finish this phase

Needs a host with a working Docker daemon, or two reachable Postgres instances. The exact commands
are in `evidence/T1-drill-BLOCKED.md`. Then:

1. Run the T1 drill; commit the log **red or green**.
2. T2, T3 follow the same pattern.
3. T4 needs the owner's ADR-0022 decision **before** rehearsal — rehearsing rollback today would
   rehearse a rebuild, which is the wrong thing to practise.
4. T5's UNMEASURED markers get replaced with the numbers the drills produce.

Still human afterwards regardless: **P5.7** (SRE signs the evidence), **P7.5** (independent
challenger rehearses rollback), **P5.1** (RTO/RPO ratified — I can measure recovery time, but whether
it is acceptable is a business decision), and backup **encryption**, which P5.6 requires and
`backup-db.sh` does not do.

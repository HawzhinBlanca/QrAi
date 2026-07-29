# Plan — deploy, rollback, and restore rehearsal

**Status: PROPOSED. No code until `Approved-by:` is filled by a human** (AGENTS.md step 2).
**Research:** `research.md`. **Measured at** main `0e49078`.
**Phase 4 of** `specs/flutter-node-migration/plan.md`. Targets **P5.5**, **P5.6**.

**Approved-by:**

---

## 1. The honest shape of this phase

Phase 4 is where I have repeatedly said the infrastructure is out of reach. Research narrows that:
**most of it is reachable, one part genuinely is not, and one part is currently impossible for a
reason worth fixing.**

| | Status |
|---|---|
| Restore drill with measured RTO | **Provable now** on isolated infra — the MIG1 technique |
| Audio-volume backup/restore | **Provable now** |
| Kill-switch behaviour | **Provable now** |
| **Rollback** | **Currently impossible to prove** — there is no artifact to roll back to (§2) |
| SRE sign-off (P5.7), challenger rehearsal (P7.5), RTO/RPO ratification (P5.1) | **Human. Not mine.** |

The distinction that matters: I can produce **measured recovery numbers**. Whether those numbers are
*acceptable* is a business decision (P5.1), and whether the evidence is *trustworthy* requires an
independent signer (P5.7). This plan produces the measurements and stops there.

---

## 2. 🔴 The blocker: "rollback" currently means "rebuild"

Every app service in `docker-compose.yml` uses `build:`; only `postgres` uses `image:`. No workflow
builds or pushes a container image. So rolling back means `git checkout <old-sha> && docker compose
build` — minutes, not seconds, and **it can fail for reasons unrelated to the code being restored.**

Not hypothetical: the postcss advisory (#261) red-lighted every branch including `main` at a commit
that had passed CI hours earlier. A rollback attempted in that window would have failed at the build
step, at exactly the moment it was needed.

Meanwhile `scripts/release-manifest.mjs:179` already demands `imageDigests`, and
`release-challenge.mjs:248` passes them onward — **the evidence system assumes immutable artifacts the
deploy path never produces.** The evidence model and the deploy model disagree; the deploy model is
the one that is wrong.

**Rehearsing a rollback before fixing this would rehearse the wrong thing.** P4-T4 fixes it first.

---

## 3. Tasks

Ordered so each produces evidence that survives the next. `verify.sh` green between each; ledger rows
flipped only by `scripts/update-ledger.sh`.

### P4-T1 — Restore script + a real, timed drill

`scripts/restore-db.sh` — the counterpart to the existing `backup-db.sh`. Restore is currently a
markdown code block, which cannot be tested, cannot be gated, and drifts silently.

Behaviour: restore a custom-format dump into a **named target database**, refuse to overwrite a
non-empty database unless `--force` is passed (the guard that stops a drill destroying real data),
verify afterwards by comparing row counts of the tables that matter, and print elapsed time.

**Drill:** isolated Postgres (separate port, staging untouched), full corpus seeded
(6,236 ayahs / 114 surahs / 82,456 words), `backup-db.sh`, drop, `restore-db.sh`, verify.
Commit the raw log with **measured wall-clock RTO** to `specs/dr-rehearsal/evidence/`.

- **Acceptance:** the drill log exists, shows a real restore, and row counts match pre-backup exactly.
- **Anti-cheat:** if the restore fails, the log is committed **red**. A failing drill is the finding;
  it must not be retried until green and then presented as a first-run success.
- **Tests (`t-p4t1-restore`)**: the empty-target guard refuses without `--force`; the row-count
  verification **fails** when a table is deliberately truncated after restore (proves the check has
  teeth rather than always passing).

### P4-T2 — Audio-volume backup + restore, and the erasure hazard

`scripts/backup-audio.sh` / restore path for the `audio_storage` volume. This is the most
privacy-sensitive data in the system and currently has no tested recovery path.

Must also address research.md §8.4: **restoring a pre-erasure backup resurrects audio a learner asked
to be deleted.** The restore procedure gains a mandatory post-restore step that re-applies outstanding
erasure requests, and the runbook states this as a legal obligation, not a nicety.

- **Acceptance:** round-trip drill log committed; a file present before backup and absent after
  erasure is **still absent** after restore + re-application.
- **Tests (`t-p4t2-audio`)**: the re-application step is invoked by the restore path, not optional.

### P4-T3 — Kill-switch drill

Prove `MAINTENANCE_MODE=1` returns 503 for app routes while `/health`, `/ready` and `/metrics` stay
live — that exemption is what makes an incident read as "up, in maintenance" rather than "crashed",
and it is what keeps monitoring working during one.

Already covered by an integration test (`maintenance_mode_503s_normal_routes_but_keeps_health_live`).
This task proves it **through the real compose stack**, not just in-process, and measures how long the
switch takes to take effect.

- **Acceptance:** drill log showing 503 on an app route and 200 on health/ready/metrics, with
  measured time-to-effect.

### P4-T4 — 🔴 Give rollback something to roll back to

The §2 blocker. Smallest correct fix: **tag images with the git SHA at build time and retain the
previous tag**, so a rollback is `docker compose up -d` against a pinned tag — seconds, and immune to
a broken build.

- Decide local-tag-retention vs registry push (research.md §8.1). A registry is the better long-term
  answer but adds CI credentials and makes an incident depend on registry availability. **Requires an
  ADR** — `docker-compose.yml` gaining an image/tag strategy is an architectural change under
  AGENTS.md.
- Wire `imageDigests` so `release-manifest.mjs`'s existing expectation is actually satisfied, closing
  the model disagreement rather than working around it.
- **Then** rehearse: deploy tag A, deploy tag B, roll back to A, verify, measure.

- **Acceptance:** ADR merged; a rollback drill log with measured time-to-restore-service.
- **Explicitly NOT in scope:** a full registry/CD pipeline. This gives rollback a target; it does not
  rebuild the deploy system.

### P4-T5 — Runbook: the sections an alert already points at

`monitoring/alerts.yml`'s `PlatformApiDown` tells an operator to *"consider kill-switch + rollback"*
and routes them to `STAGING_RUNBOOK.md`, which explains neither. Add: graceful take-down, rollback,
verify, restore-from-backup, and come back up — **with the measured numbers from T1–T4 filled in**,
not placeholders.

- **Acceptance:** every command in the new sections was actually executed in a T1–T4 drill; no step
  is written from assumption. Cross-referenced from `alerts.yml`.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| A drill runs against the live staging stack | Isolated port + explicit container name, as in MIG1; the restore script refuses a non-empty target without `--force` |
| A green drill is presented as proof for production | Every log states it is isolated infra, not production; P5.7 sign-off remains open |
| Measured RTO is mistaken for an approved RTO target | The plan measures; P5.1 ratifies. Stated in every artifact |
| T4 turns into a CD project | Scope fence in T4: a rollback target, not a pipeline |
| Restore resurrects erased audio | T2 makes erasure re-application a mandatory step, not documentation |

---

## 5. What this phase does NOT close

- **P5.7** — SRE independently signs the evidence. Unsigned evidence is evidence, not approval.
- **P7.5** — an independent challenger rehearses rollback from a clean checkout.
- **P5.1** — RTO/RPO/error-budget ratification.
- **P5.4** — load/burst/soak testing. Different phase, not smuggled in here.
- **Encryption of backups** (P5.6 says *encrypted*): `backup-db.sh` writes plaintext dumps. Naming
  this as an open decision (research.md §8.3) rather than silently satisfying half of P5.6 and
  claiming the item.

**Therefore P5.6 will remain `[ ]` after this phase**, with real drill evidence attached. Encryption
plus SRE signature are what close it. Saying so now prevents the overstatement pattern this project
has already been burned by twice.

---

## 6. Open questions

1. **T4 artifact model:** local tags or registry? (ADR required either way.)
2. **RPO:** daily dumps imply up to 24h of lost recitation/consent data. Acceptable for the pilot, or
   is WAL archiving/PITR needed? Owner call, informed by T1's measurement.
3. **Backup encryption:** required for P5.6. Where does the key live?
4. **Who runs the drills for real?** I can execute them on isolated infra and commit the logs. For
   the evidence to close P5.7 it has to be re-run and signed by whoever owns operations.

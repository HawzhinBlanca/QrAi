# Research — deploy, rollback, and restore rehearsal

**Phase 4 of** `specs/flutter-node-migration/plan.md`. Targets ledger **P5.5** (prove deploy and
rollback), **P5.6** (encrypted backup verification + timed restore/DR drill), with **P5.7** and
**P7.5** as the human sign-offs that follow.
Read-only research; no code written. **Measured at** main `0e49078`.

---

## 1. What already exists (more than expected)

| Asset | State |
|---|---|
| `scripts/backup-db.sh` | **Exists and is good.** Custom-format `pg_dump`, dated filenames that sort chronologically, rotation by count, and a guard that deletes and fails on a sub-1KB dump (a silent 0-byte "backup" is worse than a visible failure). Its own header states an on-host backup is not DR. |
| `docs/BACKUP_RESTORE.md` | Exists. Documents the restore as **manual `pg_restore` commands**, notes audio blobs live outside the DB, and has a "Restore drill" section. |
| `docs/STAGING_RUNBOOK.md` | Exists. Covers lifecycle, destroy, status/logs, secret rotation, TLS. |
| Kill-switch | **Wired end to end.** `MAINTENANCE_MODE` is plumbed in `docker-compose.yml:73` and enforced by the middleware layer inside CORS. |
| Monitoring | `monitoring/` exists (Prometheus scrape, alert rules, Grafana, compose overlay). |

So Phase 4 is not starting from zero. The gaps are specific.

---

## 2. Gap 1 — the restore drill has never been run

`docs/BACKUP_RESTORE.md` says, in its own words, that an untested backup *"is a hope, not a recovery
plan"* and instructs a real restore into a throwaway database **before go-live**. That has not
happened: there is no drill evidence anywhere in the repo, and `P5.6` is open.

**This is directly fixable and does not need production.** The MIG1 technique applies: stand up an
isolated Postgres, seed it with the real schema and real corpus, back it up with the real script,
restore it, and **measure**. That produces genuine RTO evidence rather than an estimate.

## 3. Gap 2 — restore is documentation, not a script

Backup is a tested script; restore is a code block in a markdown file. That asymmetry matters
precisely when it is used — under pressure, at night, by whoever is on call. A prose procedure cannot
be unit-tested, cannot be gated by `verify.sh`, and drifts from reality silently.

## 4. 🔴 Gap 3 — there is nothing to roll back TO

**The most consequential finding.** In `docker-compose.yml`, every application service uses
`build:` — only `postgres` uses `image:`. And no workflow ever builds or pushes a container image
(`grep -i "docker build|docker push|ghcr|registry|docker/build-push"` across `.github/workflows/`
returns nothing).

Consequences:

- **"Rollback" today means `git checkout <old-sha> && docker compose build`** — a rebuild from
  source, not a rollback. It takes minutes instead of seconds.
- **A rebuild can fail for reasons unrelated to the code being restored.** This is not theoretical:
  earlier in this project `pnpm audit` began failing repo-wide the day the postcss advisory
  published, red-lighting every branch including `main` at a commit that had passed hours before
  (fixed in #261). A rollback attempted during that window would have failed at the build step —
  exactly when you need it most.
- **P5.5 "prove rollback" is currently unprovable**, because there is no artifact to roll back to.
  Rehearsing it would only rehearse a rebuild.

### 4.1 The evidence system already assumes artifacts exist

`scripts/release-manifest.mjs:179` defines `assertImageDigests()` and `:241-243` requires build
provenance `imageDigests` to match the build summary; `scripts/release-challenge.mjs:248` passes
`RELEASE_IMAGE_DIGESTS_JSON` to the challenge job. So the release-evidence machinery was designed
around immutable, digest-pinned images — while the deploy path produces none. The evidence model and
the deploy model disagree, and the deploy model is the one that is wrong.

## 5. Gap 4 — audio blobs are outside the backup

`backup-db.sh` covers structured data only. Learner audio lives in the `audio_storage` Docker volume
(`docker-compose.yml:218`). `BACKUP_RESTORE.md` correctly says to back that up separately, but
nothing scripts it — so the most privacy-sensitive data in the system has no tested recovery path,
and no tested *deletion* path under DR conditions either (which interacts with the right-to-erasure
work already merged).

## 6. Gap 5 — the runbook has no rollback section

`STAGING_RUNBOOK.md` covers destroy/status/logs/secrets/TLS. It does not cover: take the app down
gracefully, roll back, verify, come back up. The alert rules in `monitoring/alerts.yml` already
point at this runbook for remediation (`PlatformApiDown` → *"consider kill-switch + rollback"*), so
an alert currently routes an operator to a document that does not explain the action it recommends.

---

## 7. What can be proven without production, and what cannot

**Provable now, on isolated infrastructure, with real measured numbers:**

- Backup → restore round trip, including row-count and checksum verification, with a **measured RTO**.
- The audio-volume backup/restore round trip.
- The kill-switch: app routes 503 while `/health`, `/ready`, `/metrics` stay live (that exemption is
  what makes it read as "up, in maintenance" rather than "crashed").
- A rollback, **once an artifact model exists** (Gap 3) — otherwise only a rebuild can be timed.

**Not provable by me, and must not be claimed:**

- **P5.7** — SRE independently signs the load/chaos/restore/incident/rollback evidence.
- **P7.5** — an independent challenger rehearses rollback from a clean checkout.
- **P5.1** — the owner ratifies RTO/RPO targets. I can *measure* recovery time; whether that number
  is acceptable is a business decision, not a measurement.
- Anything against production: there is no production, and no pilot has run.

---

## 8. Open questions for the plan

1. **Artifact model (blocks meaningful rollback):** tag and retain images locally from a git SHA, or
   push to a registry (GHCR)? A registry is the real answer but adds a CI capability, credentials,
   and a new runtime dependency on the registry's availability during an incident.
2. **RPO:** `backup-db.sh` is scheduled by the operator (the doc suggests 02:30 UTC daily). Daily
   dumps mean an RPO of up to 24 hours of learner recitation and consent records. Is that acceptable
   for the pilot, or is PITR/WAL archiving required? Owner call, informed by measurement.
3. **Encryption:** P5.6 says *encrypted* backup verification. `backup-db.sh` writes an unencrypted
   custom-format dump. Encryption-at-rest for the dump, and where the key lives, is undecided.
4. **Audio erasure under DR:** if a learner exercised right-to-erasure and a pre-erasure backup is
   later restored, their audio returns. That is a real privacy hazard with a legal dimension
   (P4.6), and the restore procedure must address it.

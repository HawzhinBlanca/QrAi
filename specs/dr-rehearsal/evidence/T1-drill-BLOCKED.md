# T1 restore drill — BLOCKED ON ENVIRONMENT, not run

**Date:** 2026-07-30 · **Branch:** `feat/phase4-drills` · **Attempted by:** Claude

## Status

**The drill did not run. No RTO was measured. There is no restore evidence in this repo.**

This file exists so that absence is recorded rather than inferred from silence. It is deliberately
not a partial result, an estimate, or a simulation.

## What blocked it

The Docker daemon on this host cannot start new containers. Observed:

```
docker run -d --name qrai-dr-src ... postgres:16-alpine   → container reaches "Created", never "Up"
docker start qrai-dr-src                                   → no output, no state change, no logs
docker logs qrai-dr-src                                    → empty
docker run --rm postgres:16-alpine echo ok                 → hangs past 120s
```

The six `quran-ai-staging-*` containers keep running because they were started two weeks ago; the
daemon is serving existing workloads but not accepting new ones. Waiting past three minutes did not
change it.

`psql` and `pg_dump` are also not on this host's PATH — earlier work in this repo reached Postgres
through a `docker exec` shim, which the same failure removes. So there is no alternative route to a
database from here.

## Why this is a BLOCK and not a FAILED drill

They are different findings and must not be conflated:

- A **failed drill** would mean the backup/restore procedure is broken — a real finding about the
  system, and per `plan.md` it would be committed red.
- A **blocked drill** means the procedure was never exercised. It says nothing about whether restore
  works. Recording it as a failure would be as dishonest as recording it as a pass.

## What this means for the ledger

**P5.6 remains open**, exactly as `plan.md` §5 predicted it would even on success — and now for an
additional reason. Specifically:

- Restore is **still unproven**. `docs/BACKUP_RESTORE.md`'s own instruction ("do a real restore into
  a throwaway database at least once before go-live") is **still outstanding**.
- The `scripts/restore-db.sh` delivered alongside this file is **untested against a live database**.
  Its pre-connection guards are unit-tested (`scripts/restore-db.test.sh`, 5/5) but its `pg_restore`
  invocation and row-count verification have never executed.

**Do not treat the existence of a restore script as evidence that restore works.** That inference is
the exact failure this project has been burned by before.

## How to run it (unchanged, ready to go)

On a host with a working Docker daemon, or any two reachable Postgres instances:

```bash
# 1. Source DB with the real schema + corpus
docker run -d --name qrai-dr-src -e POSTGRES_USER=hawzhin -e POSTGRES_DB=quran_ai \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5435:5432 postgres:16-alpine
# apply infra/migrations/0001..0021, then packages/quran-data/scripts/seed-full-quran-to-db.sh

# 2. Empty target DB
docker run -d --name qrai-dr-tgt -e POSTGRES_USER=hawzhin -e POSTGRES_DB=quran_ai_restored \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5436:5432 postgres:16-alpine

# 3. Back up, restore, measure
DATABASE_URL="postgresql://hawzhin@localhost:5435/quran_ai" bash scripts/backup-db.sh
RESTORE_TARGET_URL="postgresql://hawzhin@localhost:5436/quran_ai_restored" \
  bash scripts/restore-db.sh backups/quran_ai-<timestamp>.dump
```

Expected pass criteria (asserted by the script): `canonical_surahs`=114, `canonical_ayahs`=6236,
`canonical_words`=82456, and `users` / `consent_records` / `recitation_sessions` all queryable.

**Commit the resulting log here — red or green.** Per `plan.md`, a failing drill must not be retried
until green and then presented as a first-run success.

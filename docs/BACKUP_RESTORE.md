# Backup & restore runbook (P3.13)

How to back up and restore QrAi's data. Two independent things need backing up:

1. **The Postgres database** — accounts, consent records, recitation sessions, learner progress,
   teacher/scholar reviews, agent runs, audit events. Covered by `scripts/backup-db.sh`.
2. **The learner audio blobs** — raw recordings in the `audio_storage` Docker volume (retained
   per consent: 1h discard / 7d teacher-review / indefinite training-opt-in). Not in the DB;
   backed up separately (see below).

> A backup that lives on the same host as the database is **not** disaster recovery. Every
> procedure here ends by copying the artifact **off-host**.

## Database backup

```bash
DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/quran_ai" bash scripts/backup-db.sh
```

Writes a compressed, restorable `pg_dump --format=custom` file to `./backups/` (override with
`BACKUP_DIR`) named `quran_ai-<UTC-timestamp>.dump`, and keeps the newest `BACKUP_RETENTION_COUNT`
dumps (default 14), deleting older ones. The script fails loudly if the dump comes out
suspiciously small, so a silent 0-byte "success" can't happen. `backups/` and `*.dump` are
gitignored — dumps contain learner data and must never be committed.

### Scheduling (operator)

Run it daily via cron on the DB host (or a host that can reach it):

```cron
# 02:30 UTC daily
30 2 * * * cd /opt/qrai && DATABASE_URL="$DATABASE_URL" BACKUP_DIR=/var/backups/qrai bash scripts/backup-db.sh >> /var/log/qrai-backup.log 2>&1
```

Then **copy the newest dump off-host** — e.g. `aws s3 cp`, `rclone copy`, or `scp` to a separate
machine/bucket. This step is deliberately left to the operator's infra (credentials, destination)
and should be appended to the cron command or a wrapper.

## Database restore

Verified round-trip (restoring a dump into a fresh database recovers all rows):

```bash
# 1. Create a fresh target database.
createdb -h <host> -U <user> quran_ai_restored

# 2. Restore the dump (custom format -> pg_restore).
pg_restore --dbname="postgresql://<user>:<pass>@<host>:5432/quran_ai_restored" --no-owner \
  /path/to/quran_ai-<timestamp>.dump

# 3. Sanity-check row counts before cutting over.
psql "postgresql://<user>:<pass>@<host>:5432/quran_ai_restored" -c \
  "SELECT count(*) FROM canonical_ayahs;"   # expect 6236 for a full-Quran seed
```

`--no-owner` restores into whatever role you connect as (the restricted `quran_ai_app` role in
production; see `infra/sql/rls-app-role.sql`), rather than requiring the original dump's owner to
exist. To restore in place over a live database, stop platform-api first, drop/recreate `quran_ai`,
then restore — never restore over a database serving traffic.

## Audio-blob backup

The `audio_storage` volume holds minors' recordings under consent-based retention. Back it up on
the same cadence as the DB, e.g.:

```bash
docker run --rm -v qrai_audio_storage:/data -v /var/backups/qrai:/backup alpine \
  tar czf /backup/audio_storage-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .
```

Then copy off-host, same as the DB dump. Restore by extracting the tarball back into the volume.
Keep audio backups only as long as the underlying consent allows — do not retain a learner's audio
in backups past a right-to-erasure deletion; prune backups that predate an erasure as part of the
erasure workflow (coordinate with `/v1/privacy/delete`).

## Restore drill

Do a **real restore into a throwaway database at least once before go-live**, and periodically
after — an untested backup is a hope, not a recovery plan. The procedure above is the drill; a
green row-count check is the pass criterion.

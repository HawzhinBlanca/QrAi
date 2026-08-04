# Backup & restore runbook (P3.13)

How to back up and restore QrAi's data. Two independent things need backing up:

1. **The Postgres database** — accounts, consent records, recitation sessions, learner progress,
   teacher/scholar reviews, agent runs, audit events. Covered by `scripts/backup-db.sh`.
2. **The learner audio blobs** — raw recordings in the `audio_storage` Docker volume (retained
   per consent: 1h discard / 7d teacher-review / indefinite training-opt-in). Not in the DB;
   backed up separately (see below).

> A backup that lives on the same host as the database is **not** disaster recovery. Every
> procedure here ends by copying the artifact **off-host**.

## Backup encryption (P5.6) — do this first

Backups are **encrypted, and there is no flag to turn it off.** `pg_dump --format=custom` and
`tar -czf` are compression; neither is confidentiality, and until ADR-0035 this project relied on
them as though they were. A dump holds learner accounts and consent records; the audio archive holds
recordings of children reciting.

Encryption uses a **CMS envelope (RFC 5652), AES-256-GCM**, addressed to a recipient certificate.
The consequence that matters operationally: **the backup host only ever needs the PUBLIC half.** It
cannot decrypt its own backups, so compromising the machine that holds every backup yields
ciphertext. The private key is generated once, by you, offline, and this tooling never creates,
stores, or transmits it.

### Create the keypair (once, by the owner, off the backup host)

```bash
openssl req -x509 -newkey rsa:4096 -days 3650 -sha256 -nodes \
  -keyout qrai-backup-private.key -out qrai-backup-public.crt \
  -subj "/CN=QrAi backup recipient"
```

Then:

| File | Where it goes |
|---|---|
| `qrai-backup-public.crt` | On the backup host. Point `BACKUP_ENCRYPTION_CERT` at it. Not secret. |
| `qrai-backup-private.key` | **Offline.** Password manager, HSM, or sealed offline media. |

> 🔴 **The private key is the only thing that can read your backups.** Lose it and every backup
> becomes permanently unrecoverable — that is the intended property of the design, not a bug in it.
> Store at least two copies in separate physical locations before taking the first real backup.
>
> It must **never** be committed, placed on the backup host, put in CI, or passed through an
> environment variable on a shared machine. `scripts/backup-crypto.sh` refuses a private key where
> the public certificate is expected, precisely so a mix-up fails loudly instead of quietly putting
> the secret on the box holding the ciphertext.

**Rotation.** Re-run the command above to make a new pair and swap `BACKUP_ENCRYPTION_CERT`; new
backups use the new key immediately. Keep every retired private key for as long as any backup
encrypted to it is still retained — a rotated-out key is still the only way to read the archives
taken under it.

## Database backup

```bash
DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/quran_ai" \
BACKUP_ENCRYPTION_CERT=/etc/qrai/qrai-backup-public.crt \
  bash scripts/backup-db.sh
```

Writes an encrypted, restorable dump to `./backups/` (override with `BACKUP_DIR`) named
`quran_ai-<UTC-timestamp>.dump.cms`, and keeps the newest `BACKUP_RETENTION_COUNT` dumps
(default 14), deleting older ones. The script fails loudly if the dump comes out suspiciously
small, so a silent 0-byte "success" can't happen. `backups/` and `*.dump` are gitignored — dumps
contain learner data and must never be committed.

`pg_dump` is piped **straight into** the encryptor, so an unencrypted dump never exists as a file:
there is no window in which plaintext sits on disk waiting to be cleaned up, and no cleanup step
that a crash can skip.

Without `BACKUP_ENCRYPTION_CERT` the script exits 2 and writes **nothing**. That is deliberate: a
visible failure an operator fixes is better than a plaintext archive that reports success.

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

**Use `scripts/restore-db.sh`.** It decrypts, refuses a non-empty target unless `RESTORE_FORCE=1`,
has no default target, and verifies row counts afterwards rather than reporting a partial restore as
success. Driving `pg_restore` by hand skips all of that.

```bash
# 1. Create a fresh target database.
createdb -h <host> -U <user> quran_ai_restored

# 2. Restore. BACKUP_DECRYPTION_KEY is the OFFLINE private key — fetching it is part of the drill.
RESTORE_TARGET_URL="postgresql://<user>:<pass>@<host>:5432/quran_ai_restored" \
BACKUP_DECRYPTION_KEY=/path/to/qrai-backup-private.key \
  bash scripts/restore-db.sh /path/to/quran_ai-<timestamp>.dump.cms
```

The script restores with `--no-owner`, so the dump lands in whatever role you connect as (the
restricted `quran_ai_app` role in production; see `infra/sql/rls-app-role.sql`) rather than requiring
the original owner to exist. To restore in place over a live database, stop platform-api first,
drop/recreate `quran_ai`, then restore — never restore over a database serving traffic.

> **Restore is the one step that puts plaintext on disk.** `pg_restore` seeks within a custom-format
> archive and `--jobs` requires a real file, so the dump is decrypted to a `mktemp` file with
> owner-only permissions and removed by a trap on every exit path, including failure and Ctrl-C.
> The backup direction has no such window; this one does, and it is bounded rather than absent.

## Audio-blob backup

The `audio_storage` volume holds minors' recordings under consent-based retention — the most
sensitive data this project stores.

**Use `scripts/backup-audio.sh`.** It encrypts, and it verifies that the archive holds as many files
as the source tree did, so a backup that silently drops recordings fails instead of reporting
success.

```bash
AUDIO_BACKUP_SOURCE=/var/lib/docker/volumes/qrai_audio_storage/_data \
BACKUP_ENCRYPTION_CERT=/etc/qrai/qrai-backup-public.crt \
  bash scripts/backup-audio.sh /var/backups/qrai
```

> ⚠️ Earlier versions of this document gave a bare `docker run ... tar czf ...` here. That produces
> an **unencrypted** archive of children's recordings, and `tar -czf` is compression, not
> confidentiality. Do not use it. If any archive produced that way still exists, it is plaintext —
> treat it as an exposure and destroy it.

Restore with `scripts/restore-audio.sh`, never by extracting the archive by hand: restoring a
pre-erasure backup **resurrects audio a learner asked to have deleted**, and re-applying outstanding
erasure requests is a mandatory step of that script rather than a line in this runbook.

```bash
AUDIO_RESTORE_TARGET=/var/lib/docker/volumes/qrai_audio_storage/_data \
ERASURE_DATABASE_URL="postgresql://<superuser>@<host>:5432/quran_ai" \
BACKUP_DECRYPTION_KEY=/path/to/qrai-backup-private.key \
  bash scripts/restore-audio.sh /var/backups/qrai/audio-storage-<stamp>.tar.gz.cms
```

Keep audio backups only as long as the underlying consent allows, and prune backups that predate an
erasure as part of the erasure workflow (coordinate with `/v1/privacy/delete`).

## Restore drill

Do a **real restore into a throwaway database at least once before go-live**, and periodically
after — an untested backup is a hope, not a recovery plan. The procedure above is the drill; a
green row-count check is the pass criterion.

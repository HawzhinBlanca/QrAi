#!/usr/bin/env bash
# Postgres backup for QrAi (P3.13). Takes a compressed, restorable pg_dump of the platform
# database, writes it to a dated file, and rotates old backups. Restore procedure + scheduling
# guidance: docs/BACKUP_RESTORE.md.
#
# This covers the STRUCTURED data (accounts, consent records, recitation sessions, progress,
# reviews). The learner AUDIO blobs live in the `audio_storage` Docker volume, not the DB — back
# that up separately (see docs/BACKUP_RESTORE.md).
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/quran_ai bash scripts/backup-db.sh
# Env:
#   DATABASE_URL             Postgres connection string (required unless PG* vars are set).
#   BACKUP_DIR               Where to write dumps (default: ./backups).
#   BACKUP_RETENTION_COUNT   How many most-recent dumps to keep (default: 14).
#
# IMPORTANT: a backup on the same host as the database is not disaster recovery. Copy the dump
# OFF-HOST (rclone/aws s3 cp/scp) — the operator wires that after this script; see the runbook.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"

if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  echo "error: set DATABASE_URL (or PG* env vars) to the Postgres to back up" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found on PATH (install the postgresql client)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# %Y%m%dT%H%M%SZ (UTC) sorts lexicographically == chronologically, so rotation-by-name is correct.
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="$BACKUP_DIR/quran_ai-${timestamp}.dump"

echo "backing up database -> $outfile"
# --format=custom: compressed and restorable with pg_restore (selective restore, parallelism).
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --file="$outfile" "$DATABASE_URL"
else
  pg_dump --format=custom --file="$outfile"
fi

# Fail loudly if the dump is empty/tiny — a 0-byte "backup" that silently succeeded is worse than
# a visible failure (a custom-format dump of even an empty schema is comfortably over 1KB).
size_bytes="$(wc -c <"$outfile" | tr -d ' ')"
if [[ "$size_bytes" -lt 1024 ]]; then
  echo "error: dump is only ${size_bytes} bytes — treating as a failed backup" >&2
  rm -f "$outfile"
  exit 1
fi
echo "backup complete: $outfile (${size_bytes} bytes)"

# Rotation: keep the newest BACKUP_RETENTION_COUNT dumps, delete older ones.
# Collect the sorted dump list without `mapfile` (absent in bash 3.2, e.g. stock macOS).
dumps=()
while IFS= read -r dumpfile; do
  dumps+=("$dumpfile")
done < <(ls -1 "$BACKUP_DIR"/quran_ai-*.dump 2>/dev/null | sort)
excess=$(( ${#dumps[@]} - BACKUP_RETENTION_COUNT ))
if (( excess > 0 )); then
  for ((i = 0; i < excess; i++)); do
    echo "rotating out old backup: ${dumps[$i]}"
    rm -f "${dumps[$i]}"
  done
fi

echo "done. ${BACKUP_RETENTION_COUNT} most-recent dumps retained in $BACKUP_DIR"
echo "reminder: copy $outfile off-host — an on-host backup is not disaster recovery."

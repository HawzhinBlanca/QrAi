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
#   DATABASE_URL=postgresql://user:pass@host:5432/quran_ai \
#     BACKUP_ENCRYPTION_CERT=/etc/qrai/qrai-backup-public.crt bash scripts/backup-db.sh
# Env:
#   DATABASE_URL             Postgres connection string (required unless PG* vars are set).
#   BACKUP_ENCRYPTION_CERT   REQUIRED. Public X.509 cert of the backup recipient (see below).
#   BACKUP_DIR               Where to write dumps (default: ./backups).
#   BACKUP_RETENTION_COUNT   How many most-recent dumps to keep (default: 14).
#
# ENCRYPTION (P5.6): this dump holds learner accounts, consent records and progress, so it is
# written as an encrypted CMS envelope and there is no flag to write it in the clear.
# `--format=custom` is COMPRESSION, which this script previously relied on as though it were
# confidentiality. Only the recipient's PUBLIC certificate is needed here — this host cannot decrypt
# what it writes. See scripts/backup-crypto.sh for the design and docs/BACKUP_RESTORE.md for how the
# owner creates the keypair.
#
# IMPORTANT: a backup on the same host as the database is not disaster recovery. Copy the dump
# OFF-HOST (rclone/aws s3 cp/scp) — the operator wires that after this script; see the runbook.

set -euo pipefail

# shellcheck source=scripts/backup-crypto.sh
. "$(dirname "$0")/backup-crypto.sh"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"

if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  echo "error: set DATABASE_URL (or PG* env vars) to the Postgres to back up" >&2
  exit 1
fi

# Checked FIRST — before pg_dump even has to exist, and long before it runs.
#
# Two reasons. A ten-minute dump that then fails to encrypt has both wasted the time and left the
# operator wondering whether something sensitive is sitting on disk. And ordering the POLICY check
# ahead of the CAPABILITY check means "this data may not be written unencrypted" is reported the same
# way on every host, instead of being masked on some of them by a missing client binary.
backup_crypto_require_cert || exit 2

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found on PATH (install the postgresql client)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# %Y%m%dT%H%M%SZ (UTC) sorts lexicographically == chronologically, so rotation-by-name is correct.
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="$BACKUP_DIR/quran_ai-${timestamp}.dump${BACKUP_CRYPTO_SUFFIX}"

echo "backing up database -> $outfile"
# --format=custom: compressed and restorable with pg_restore (selective restore, parallelism).
#
# Piped STRAIGHT into the encryptor rather than written with --file and encrypted afterwards. The
# two-step version would leave an unencrypted dump on disk for however long the encryption took, and
# a crash or SIGKILL in that window leaves it there permanently. This way the plaintext only ever
# exists in a pipe. `set -o pipefail` (above) makes a pg_dump failure fail the whole pipeline.
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom "$DATABASE_URL" | backup_crypto_encrypt_stream "$outfile"
else
  pg_dump --format=custom | backup_crypto_encrypt_stream "$outfile"
fi

# Fail loudly if the dump is empty/tiny — a 0-byte "backup" that silently succeeded is worse than
# a visible failure (a custom-format dump of even an empty schema is comfortably over 1KB, and the
# CMS envelope only adds to that, so the floor stays valid under encryption).
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
# The glob is `.dump*`, not `.dump${BACKUP_CRYPTO_SUFFIX}`: a directory written before encryption
# existed still holds bare `.dump` files, and those are the MOST urgent ones to rotate out, being the
# plaintext ones. Sorting stays correct because the UTC timestamp precedes the extension.
done < <(ls -1 "$BACKUP_DIR"/quran_ai-*.dump* 2>/dev/null | sort)
excess=$(( ${#dumps[@]} - BACKUP_RETENTION_COUNT ))
if (( excess > 0 )); then
  for ((i = 0; i < excess; i++)); do
    echo "rotating out old backup: ${dumps[$i]}"
    rm -f "${dumps[$i]}"
  done
fi

echo "done. ${BACKUP_RETENTION_COUNT} most-recent dumps retained in $BACKUP_DIR"
echo "reminder: copy $outfile off-host — an on-host backup is not disaster recovery."

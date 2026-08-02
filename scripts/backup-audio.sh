#!/usr/bin/env bash
# Audio-storage backup for QrAi (P4-T2, specs/dr-rehearsal/plan.md).
#
# The audio volume is the most privacy-sensitive data in the system — raw recordings of children
# reciting — and until this it had no tested recovery path at all. scripts/backup-db.sh covers
# Postgres; the DB holds only DERIVED records (alignments, findings, timings). Losing the volume
# loses the recordings a teacher review is about.
#
# Usage:
#   AUDIO_BACKUP_SOURCE=/data/audio-storage bash scripts/backup-audio.sh [output-dir]
#
# Env:
#   AUDIO_BACKUP_SOURCE  REQUIRED, no default. The audio storage directory to back up.
#   AUDIO_BACKUP_DIR     Output directory (default: ./backups, or $1).
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# NO DEFAULT SOURCE, for the reason scripts/restore-db.sh spells out at length: a script that fell
# back to a well-known path would happily back up (or, on the restore side, overwrite) whatever
# happened to be there. Unset means exit, never guess.
#
# READ THE RESTORE SCRIPT BEFORE USING THIS ONE. A backup of audio is a snapshot of recordings some
# of which a learner may later ask to have erased; restoring it naively puts them back. That is what
# scripts/restore-audio.sh's mandatory erasure re-application exists to prevent, and it is a legal
# obligation rather than a nicety.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

if [[ -z "${AUDIO_BACKUP_SOURCE:-}" ]]; then
  echo "error: AUDIO_BACKUP_SOURCE is required and has NO default." >&2
  echo "       This is deliberate — see the safety note at the top of this script." >&2
  exit 2
fi

source_dir="$AUDIO_BACKUP_SOURCE"

if [[ ! -d "$source_dir" ]]; then
  echo "error: audio storage directory not found: $source_dir" >&2
  exit 2
fi

out_dir="${1:-${AUDIO_BACKUP_DIR:-backups}}"
mkdir -p "$out_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$out_dir/audio-storage-$stamp.tar.gz"

# Counted BEFORE the archive is written, from the live tree — so the verification below compares two
# independently produced numbers rather than the archive against itself.
file_count="$(find "$source_dir" -type f | wc -l | tr -d ' ')"

echo "==> backing up $source_dir ($file_count files)"
started="$(date +%s)"

# `-C "$source_dir" .` stores paths RELATIVE to the storage root: `tenant/learner/chunk.bin`. That
# is the same shape as `privacy_jobs.audio_object_keys_deleted`, which is what makes the restore
# script's erasure re-application a direct key lookup instead of a path-rewriting exercise.
tar -czf "$archive" -C "$source_dir" .

elapsed="$(( $(date +%s) - started ))"

archived_count="$(tar -tzf "$archive" | grep -cv '/$' || true)"
if [[ "$archived_count" -ne "$file_count" ]]; then
  echo "FAIL: archive holds $archived_count files, the source has $file_count" >&2
  echo "      A backup that silently drops files is worse than no backup: it reports success." >&2
  rm -f "$archive"
  exit 1
fi

size="$(du -h "$archive" | cut -f1)"
echo "OK   $archive"
echo "     $archived_count files, $size, ${elapsed}s"
echo
echo "     Restore with:  AUDIO_RESTORE_TARGET=<dir> bash scripts/restore-audio.sh $archive"
echo "     That path RE-APPLIES outstanding erasure requests. Do not untar this by hand."

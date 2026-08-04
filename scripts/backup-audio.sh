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
#   AUDIO_BACKUP_SOURCE     REQUIRED, no default. The audio storage directory to back up.
#   BACKUP_ENCRYPTION_CERT  REQUIRED. Public X.509 cert of the backup recipient.
#   AUDIO_BACKUP_DIR        Output directory (default: ./backups, or $1).
#
# ENCRYPTION (P5.6): of everything this project stores, this archive is the most sensitive — it is
# the children's voices themselves. `tar -czf` is COMPRESSION; it was never confidentiality, and
# this script previously treated it as though it were. The archive is now written as an encrypted
# CMS envelope using only the recipient's PUBLIC certificate, so this host cannot read back what it
# just wrote. See scripts/backup-crypto.sh.
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

# shellcheck source=scripts/backup-crypto.sh
. "$(dirname "$0")/backup-crypto.sh"

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

# Checked before any archiving work starts — see the same note in scripts/backup-db.sh.
backup_crypto_require_cert || exit 2

out_dir="${1:-${AUDIO_BACKUP_DIR:-backups}}"
mkdir -p "$out_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$out_dir/audio-storage-$stamp.tar.gz${BACKUP_CRYPTO_SUFFIX}"

# Counted BEFORE the archive is written, from the live tree — so the verification below compares two
# independently produced numbers rather than the archive against itself.
file_count="$(find "$source_dir" -type f | wc -l | tr -d ' ')"

echo "==> backing up $source_dir ($file_count files)"
started="$(date +%s)"

# `-C "$source_dir" .` stores paths RELATIVE to the storage root: `tenant/learner/chunk.bin`. That
# is the same shape as `privacy_jobs.audio_object_keys_deleted`, which is what makes the restore
# script's erasure re-application a direct key lookup instead of a path-rewriting exercise.
#
# Piped into the encryptor rather than written and then encrypted, so the plaintext tarball of
# children's recordings never exists as a file. `-v` makes tar report each member on stderr as it
# writes it, which is what the count below is taken from.
manifest="$(mktemp)"
# INT/TERM as well as EXIT: the manifest lists the PATHS of learner recordings
# (`tenant/learner/chunk.bin`). That is metadata rather than audio, but it still names which learners
# have recordings, and a Ctrl-C during a long backup should not leave it behind.
trap 'rm -f "$manifest"' EXIT INT TERM
tar -czvf - -C "$source_dir" . 2>"$manifest" | backup_crypto_encrypt_stream "$archive"

elapsed="$(( $(date +%s) - started ))"

# The original check read the archive back with `tar -tzf`. That is no longer possible on this host,
# and deliberately so: it holds no private key, so it cannot decrypt what it just wrote. The count
# therefore comes from what tar REPORTED archiving, which is still a number produced independently
# of `find` — so the comparison below still catches a silent drop, which is what it was for.
#
# What it no longer proves is that the archive reads back. That check moved to the restore drill,
# where the key is present; it is the drill's job and is stated as such rather than quietly lost.
#
# Parsing note, learned by getting it wrong: BSD tar prints `a ./tenant/learner/chunk.bin` and lists
# DIRECTORIES too, with no trailing slash to filter on — so the obvious `grep -cv '/$'` counts every
# directory as a file and reports 8 members for a 3-file tree. GNU tar prints the bare path. Both are
# handled by stripping an optional `a ` and then asking the filesystem whether the entry is a regular
# file, rather than trying to infer that from the text.
archived_count=0
while IFS= read -r line; do
  entry="${line#a }"
  [[ -f "$source_dir/$entry" ]] && archived_count=$((archived_count + 1))
done < "$manifest"
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

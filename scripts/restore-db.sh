#!/usr/bin/env bash
# Postgres restore for QrAi (P4-T1, specs/dr-rehearsal/plan.md). The tested counterpart to
# scripts/backup-db.sh.
#
# WHY THIS IS A SCRIPT AND NOT A DOC: restore used to live as a code block in
# docs/BACKUP_RESTORE.md. A prose procedure cannot be tested, cannot be gated by verify.sh, and
# drifts from reality silently — and it is read for the first time under pressure, at night, by
# whoever is on call. This runs the same way every time and fails loudly when it does not.
#
# Usage:
#   RESTORE_TARGET_URL=postgresql://user:pass@host:5432/quran_ai_restored \
#     BACKUP_DECRYPTION_KEY=/path/to/qrai-backup-private.key \
#     bash scripts/restore-db.sh path/to/quran_ai-<timestamp>.dump.cms
#
# Env:
#   RESTORE_TARGET_URL     REQUIRED. Connection string for the database to restore INTO.
#   BACKUP_DECRYPTION_KEY  REQUIRED for encrypted (.cms) backups — the offline private key.
#   RESTORE_FORCE=1        Allow restoring into a database that already has rows (default: refuse).
#   RESTORE_JOBS           pg_restore parallelism (default: 4).
#   RESTORE_APP_DATABASE_PASSWORD  REQUIRED. Rotates/provisions the restricted runtime role after
#                                  forward migrations complete.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# SAFETY: this script deliberately has NO DEFAULT for its target.
#
# scripts/verify.sh:28 exports a DEFAULT DATABASE_URL pointing at a real local database. A restore
# script that fell back to DATABASE_URL would inherit that default and overwrite a developer's own
# data during what they believed was a drill. So the target is a SEPARATE, required variable
# (RESTORE_TARGET_URL) and there is no fallback: unset means exit, never guess.
#
# It also refuses a non-empty target unless RESTORE_FORCE=1, so the destructive case is opt-in and
# visible in the shell history of whoever did it.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# shellcheck source=scripts/backup-crypto.sh
. "$(dirname "$0")/backup-crypto.sh"

dump_file="${1:-}"

if [[ -z "$dump_file" ]]; then
  echo "usage: RESTORE_TARGET_URL=<url> bash scripts/restore-db.sh <dump-file>" >&2
  exit 2
fi

if [[ ! -f "$dump_file" ]]; then
  echo "error: dump file not found: $dump_file" >&2
  exit 2
fi

if [[ -z "${RESTORE_TARGET_URL:-}" ]]; then
  echo "error: RESTORE_TARGET_URL is required and has NO default." >&2
  echo "       This is deliberate — see the safety note at the top of this script." >&2
  exit 2
fi

restore_app_database_password="${RESTORE_APP_DATABASE_PASSWORD:-}"
if [[ ${#restore_app_database_password} -lt 16 ]]; then
  echo "error: RESTORE_APP_DATABASE_PASSWORD is required and must contain at least 16 characters." >&2
  exit 2
fi

for tool in pg_restore psql node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found on PATH (install the postgresql client)" >&2
    exit 1
  fi
done

# --- Decryption (P5.6) ---------------------------------------------------------------------------
# Backups are encrypted CMS envelopes. Unlike the backup direction — where the dump is piped straight
# into the encryptor and plaintext never exists as a file — a restore MUST materialise the dump:
# pg_restore seeks within a custom-format archive, and `--jobs` requires a real seekable file.
#
# So this is the one place in the backup lifecycle where a decrypted dump touches disk. It is
# created under `mktemp` with `umask 077` (owner-only) and removed by the trap below on ANY exit
# path, including failure and Ctrl-C. That is a genuine, bounded exposure rather than an absent one,
# and it is written down here so nobody has to rediscover it.
restore_source="$dump_file"
decrypted_tmp=""
cleanup() {
  if [[ -n "$decrypted_tmp" && -f "$decrypted_tmp" ]]; then rm -f "$decrypted_tmp"; fi
  # `return 0` is load-bearing, not tidiness. Written as a one-line
  # `[[ ... ]] && rm -f ...`, the test is FALSE whenever there is no temp file to remove — an
  # unencrypted dump, or a decrypt that never happened — so the trap's last command exits 1. On an
  # EXIT trap bash then uses that status, and a restore that fully succeeded reports FAILURE.
  # Measured, not theorised. The wrong direction is harmless-looking (a false alarm rather than a
  # masked failure), but an operator reading it at 3am cannot tell which they are looking at.
  return 0
}
trap cleanup EXIT INT TERM

if backup_crypto_is_encrypted "$dump_file"; then
  backup_crypto_require_key || exit 2
  decrypted_tmp="$(mktemp "${TMPDIR:-/tmp}/qrai-restore-XXXXXX.dump")"
  echo "decrypting $dump_file"
  backup_crypto_decrypt "$dump_file" "$decrypted_tmp" || exit 1
  restore_source="$decrypted_tmp"
else
  # A bare .dump predates encryption (or was hand-made). Restoring it is allowed — refusing would
  # make old backups unrecoverable, which is the opposite of what a restore path is for — but it is
  # called out, because its existence on disk is itself the P5.6 problem.
  echo "WARNING: $dump_file is NOT encrypted." >&2
  echo "         It predates P5.6 backup encryption. Restoring it is permitted, but the file is" >&2
  echo "         readable by anyone with disk access — handle and delete it accordingly." >&2
fi

target="$RESTORE_TARGET_URL"
jobs="${RESTORE_JOBS:-4}"

# --- Guard: refuse to clobber a database that already holds data ---------------------------------
# `users` is the canary: it exists in 0001_core_schema.sql and is non-empty in any seeded
# environment. A missing table means an empty/fresh target, which is the expected drill case.
existing_rows="$(psql "$target" -tAc \
  "SELECT COALESCE((SELECT count(*) FROM users), 0)" 2>/dev/null || echo "0")"
existing_rows="$(echo "$existing_rows" | tr -d '[:space:]')"
[[ "$existing_rows" =~ ^[0-9]+$ ]] || existing_rows=0

if [[ "$existing_rows" -gt 0 && "${RESTORE_FORCE:-0}" != "1" ]]; then
  echo "REFUSED: target already has ${existing_rows} row(s) in 'users'." >&2
  echo "         Restoring would overwrite live data. Set RESTORE_FORCE=1 to proceed anyway," >&2
  echo "         or point RESTORE_TARGET_URL at a fresh database." >&2
  exit 3
fi

echo "restoring $dump_file -> $target"
start_epoch="$(date -u +%s)"

# --clean --if-exists: drop objects before recreating, so a re-run is idempotent.
# --no-owner: the dump's owner role may not exist in the target (e.g. restoring prod into a drill DB).
# Not using ON_ERROR_STOP semantics here: pg_restore reports per-object errors and a non-zero exit,
# which the `if` below turns into a hard failure rather than a warning nobody reads.
if ! pg_restore --dbname="$target" --clean --if-exists --no-owner --jobs="$jobs" "$restore_source"; then
  echo "error: pg_restore reported failures — treat this restore as FAILED, not partial." >&2
  exit 1
fi

# A backup may predate the migration ledger or the newest additive migration. Restore the data
# first, then converge it through the same checksum-locked boundary used by Compose, CI, staging,
# and release. Role rotation is separate from immutable schema history but mandatory before this
# restored database is considered ready for application traffic.
migration_runner="${MIGRATION_RUNNER:-$(dirname "$0")/../server/scripts/migrate.mjs}"
role_provisioner="${ROLE_PROVISIONER:-$(dirname "$0")/../server/scripts/provision-role.mjs}"
MIGRATION_DATABASE_URL="$target" node "$migration_runner"
MIGRATION_DATABASE_URL="$target" APP_DATABASE_PASSWORD="$restore_app_database_password" \
  node "$role_provisioner"

end_epoch="$(date -u +%s)"
elapsed=$(( end_epoch - start_epoch ))
# `date +%s` has 1-second resolution, so a fast restore reports "0s" — which is not a usable
# measurement and would be misread as "instant". Report sub-second honestly instead.
if [[ "$elapsed" -eq 0 ]]; then elapsed_str="<1s"; else elapsed_str="${elapsed}s"; fi

# --- Verification: a restore that "succeeded" but restored nothing is the failure that hides ------
echo ""
echo "verifying restored row counts:"
verify_failed=0
for pair in "canonical_surahs:114" "canonical_ayahs:6236" "canonical_words:82456"; do
  table="${pair%%:*}"
  expected="${pair##*:}"
  actual="$(psql "$target" -tAc "SELECT count(*) FROM ${table}" 2>/dev/null | tr -d '[:space:]' || echo "ERR")"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %-20s %s\n' "$table" "$actual"
  else
    printf '  FAIL %-20s expected %s, got %s\n' "$table" "$expected" "$actual"
    verify_failed=1
  fi
done

# Tables whose contents vary by environment: assert they RESTORED (schema present + queryable),
# not a fixed count, or the check would be wrong the moment a real pilot has data.
for table in users consent_records recitation_sessions; do
  actual="$(psql "$target" -tAc "SELECT count(*) FROM ${table}" 2>/dev/null | tr -d '[:space:]' || echo "ERR")"
  if [[ "$actual" == "ERR" ]]; then
    printf '  FAIL %-20s table missing after restore\n' "$table"
    verify_failed=1
  else
    printf '  ok   %-20s %s row(s)\n' "$table" "$actual"
  fi
done

echo ""
if [[ "$verify_failed" -ne 0 ]]; then
  echo "RESTORE VERIFICATION FAILED after ${elapsed_str} — do NOT cut over to this database." >&2
  exit 1
fi

echo "RESTORE OK in ${elapsed_str} (measured wall-clock, 1s resolution)."
echo ""
echo "NOTE: this measurement is a FLOOR, not a prediction. A drill on isolated infrastructure has"
echo "no network latency, no concurrent load, and a 6,236-ayah corpus is not a year of pilot audio."
echo ""
echo "REQUIRED next step if this restored a PRE-ERASURE backup: re-apply outstanding right-to-erasure"
echo "requests. A restore resurrects audio and records a learner asked to have deleted."
echo "See docs/BACKUP_RESTORE.md."

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
#     bash scripts/restore-db.sh path/to/quran_ai-<timestamp>.dump
#
# Env:
#   RESTORE_TARGET_URL   REQUIRED. Connection string for the database to restore INTO.
#   RESTORE_FORCE=1      Allow restoring into a database that already has rows (default: refuse).
#   RESTORE_JOBS         pg_restore parallelism (default: 4).
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

for tool in pg_restore psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found on PATH (install the postgresql client)" >&2
    exit 1
  fi
done

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
if ! pg_restore --dbname="$target" --clean --if-exists --no-owner --jobs="$jobs" "$dump_file"; then
  echo "error: pg_restore reported failures — treat this restore as FAILED, not partial." >&2
  exit 1
fi

end_epoch="$(date -u +%s)"
elapsed=$(( end_epoch - start_epoch ))

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
  echo "RESTORE VERIFICATION FAILED after ${elapsed}s — do NOT cut over to this database." >&2
  exit 1
fi

echo "RESTORE OK in ${elapsed}s (measured wall-clock)."
echo ""
echo "NOTE: this measurement is a FLOOR, not a prediction. A drill on isolated infrastructure has"
echo "no network latency, no concurrent load, and a 6,236-ayah corpus is not a year of pilot audio."
echo ""
echo "REQUIRED next step if this restored a PRE-ERASURE backup: re-apply outstanding right-to-erasure"
echo "requests. A restore resurrects audio and records a learner asked to have deleted."
echo "See docs/BACKUP_RESTORE.md."

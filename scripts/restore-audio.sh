#!/usr/bin/env bash
# Audio-storage restore for QrAi (P4-T2, specs/dr-rehearsal/plan.md) — the tested counterpart to
# scripts/backup-audio.sh.
#
# Usage:
#   AUDIO_RESTORE_TARGET=/data/audio-storage \
#   ERASURE_DATABASE_URL=postgresql://... \
#   BACKUP_DECRYPTION_KEY=/path/to/qrai-backup-private.key \
#     bash scripts/restore-audio.sh backups/audio-storage-<stamp>.tar.gz.cms
#
# Env:
#   AUDIO_RESTORE_TARGET   REQUIRED, no default. Directory to restore INTO.
#   ERASURE_DATABASE_URL   REQUIRED, no default. Database holding privacy_jobs.
#   BACKUP_DECRYPTION_KEY  REQUIRED for encrypted (.cms) archives — the offline private key.
#   RESTORE_FORCE=1        Allow restoring into a non-empty target (default: refuse).
#
# ═════════════════════════════════════════════════════════════════════════════════════════════════
# THE HAZARD THIS SCRIPT EXISTS FOR — research.md §8.4
#
# Restoring a pre-erasure backup RESURRECTS audio a learner asked to have deleted. The backup was
# taken on Monday, the learner exercised their right to erasure on Tuesday, the volume was lost on
# Wednesday — and a naive restore on Thursday puts every one of their recordings back, with nothing
# anywhere reporting that it happened. The deletion request is still satisfied in the database; only
# the bytes came back.
#
# So re-applying outstanding erasures is a STEP OF THE RESTORE, not a line in a runbook. Two things
# make that real rather than aspirational:
#
#   1. The erasure list is read BEFORE anything is extracted. If the database is unreachable, or the
#      query fails, or a key looks unsafe, the restore has not started yet and this exits non-zero
#      having changed nothing. The alternative ordering — extract, then try to re-apply — has a
#      failure mode where the audio is already back and the process dies before removing it.
#   2. There is no flag that bypasses it. Such an escape hatch would be reached for at 3am by
#      whoever was under the most pressure to get the service back — the worst possible moment for
#      it to exist.
#
# `privacy_jobs.audio_object_keys_deleted` is the authoritative record: platform-api writes the
# exact object keys the ML service reported deleting (handlers/privacy.rs), so re-application is a
# lookup, not a reconstruction.
# ═════════════════════════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# shellcheck source=scripts/backup-crypto.sh
. "$(dirname "$0")/backup-crypto.sh"

archive="${1:-}"

if [[ -z "$archive" ]]; then
  echo "usage: AUDIO_RESTORE_TARGET=<dir> ERASURE_DATABASE_URL=<url> bash scripts/restore-audio.sh <archive>" >&2
  exit 2
fi

if [[ ! -f "$archive" ]]; then
  echo "error: archive not found: $archive" >&2
  exit 2
fi

if [[ -z "${AUDIO_RESTORE_TARGET:-}" ]]; then
  echo "error: AUDIO_RESTORE_TARGET is required and has NO default." >&2
  echo "       A default would overwrite whatever audio storage happened to be at that path." >&2
  exit 2
fi

if [[ -z "${ERASURE_DATABASE_URL:-}" ]]; then
  echo "error: ERASURE_DATABASE_URL is required and has NO default." >&2
  echo "       Outstanding erasure requests cannot be re-applied without it, and a restore that" >&2
  echo "       skips re-application resurrects audio a learner asked to have deleted." >&2
  exit 2
fi

# Checked HERE, with the other pre-flight validations, rather than at the extraction step — this
# script's governing rule is that anything which can fail should fail while the answer is still
# "exited, having changed nothing".
if backup_crypto_is_encrypted "$archive"; then
  backup_crypto_require_key || exit 2
else
  echo "WARNING: $archive is NOT encrypted — it predates P5.6 backup encryption." >&2
  echo "         Restoring it is permitted; the plaintext archive of learner recordings on disk is" >&2
  echo "         itself the exposure, so delete it once this restore is done." >&2
fi

target="$AUDIO_RESTORE_TARGET"

# ── 1. Refuse a non-empty target unless forced ──────────────────────────────────────────────────
# FIRST, before the tooling check below: this is a pure filesystem guard, and the case it protects
# against — restoring over live audio — does not become safe because psql happens to be missing.
if [[ -d "$target" ]] && [[ -n "$(find "$target" -type f -print -quit 2>/dev/null)" ]]; then
  if [[ "${RESTORE_FORCE:-}" != "1" ]]; then
    echo "REFUSED: $target already contains files." >&2
    echo "         Restoring over live audio storage would overwrite recordings that are not in" >&2
    echo "         this archive. Re-run with RESTORE_FORCE=1 if that is genuinely what you want." >&2
    exit 3
  fi
  echo "==> RESTORE_FORCE=1 — restoring over a non-empty target"
fi

# ── 2. Read the erasure list FIRST, before a single byte is extracted ───────────────────────────
# PSQL_BIN exists because the client is not always on the host — on a machine where Postgres runs
# only in Docker, the drill this script is judged by would be impossible to run otherwise:
#   PSQL_BIN="docker exec -i qrai-staging-pg psql"
# Split on whitespace into an array so a multi-word command works. It is NOT a way to skip the
# erasure step: whatever is named here must still answer the query, or the restore exits below.
read -ra psql_cmd <<< "${PSQL_BIN:-psql}"
if ! command -v "${psql_cmd[0]}" >/dev/null 2>&1; then
  echo "error: '${psql_cmd[0]}' not found on PATH." >&2
  echo "       Install the postgresql client, or set PSQL_BIN (e.g. \"docker exec -i <container> psql\")." >&2
  exit 1
fi

# A volume restore spans every tenant on that volume, so the erasure list must too — RLS scopes
# `privacy_jobs` to one tenant and this operation has no single tenant to be. `app.bypass_rls` is the
# documented escape (infra/sql/0003_tenant_rls.sql), and it is ASSERTED rather than assumed:
#
#   without it, and under a role that does not bypass RLS, the query returns ZERO ROWS. Not an
#   error — an empty erasure list. The restore would then proceed happily and put every erased
#   recording back, which is precisely the outcome this entire script exists to prevent. A silent
#   empty answer is the most dangerous possible result here, so the guard checks the MECHANISM
#   (did bypass actually take effect?) rather than the row count, which cannot tell "no erasures
#   have ever been requested" apart from "RLS hid all of them".
echo "==> reading outstanding erasure requests"
# The CAPABILITY, not the flag. `app.is_rls_bypass_enabled()` (0012_superuser_only_rls_bypass.sql)
# honours `app.bypass_rls` only for a superuser, precisely because any role can set a custom GUC —
# so an ordinary role sets it, reads back 'on', and RLS still hides every other tenant's rows.
#
# Checking the flag instead of the capability is a mistake this script made and a real drill caught:
# it passed as a superuser and, under a restricted role, read an EMPTY erasure list and restored
# every deleted recording while reporting success. An empty list is the most dangerous possible
# answer here and it is indistinguishable from "nobody has asked to be erased", so the only safe
# behaviour is to refuse unless cross-tenant reads are genuinely available.
if ! can_bypass="$("${psql_cmd[@]}" "$ERASURE_DATABASE_URL" -Atq -c \
  "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" 2>&1 | tail -1)"; then
  echo "FAIL: could not reach the database to check the erasure-read role:" >&2
  echo "$can_bypass" >&2
  exit 1
fi
if [[ "$can_bypass" != "t" ]]; then
  echo "FAIL: '$("${psql_cmd[@]}" "$ERASURE_DATABASE_URL" -Atq -c 'SELECT current_user' 2>/dev/null)'" \
       "cannot read across tenants." >&2
  echo "      A volume restore spans every tenant on the volume, so the erasure list must too, but" >&2
  echo "      row-level security scopes privacy_jobs to one tenant and app.bypass_rls is honoured" >&2
  echo "      only for a superuser (infra/sql/0012_superuser_only_rls_bypass.sql)." >&2
  echo "      Under this role the erasure list would come back EMPTY — indistinguishable from" >&2
  echo "      'nobody asked to be erased' — and the restore would put every deleted recording back." >&2
  echo "      Re-run with a superuser connection. Nothing has been extracted." >&2
  exit 1
fi

if ! erasure_keys="$("${psql_cmd[@]}" "$ERASURE_DATABASE_URL" -Atq -c \
  "SELECT set_config('app.bypass_rls', 'on', false);
   SELECT jsonb_array_elements_text(audio_object_keys_deleted)
     FROM privacy_jobs
    WHERE kind = 'delete'" 2>&1 | tail -n +2)"; then
  echo "FAIL: could not read privacy_jobs from the database:" >&2
  echo "$erasure_keys" >&2
  echo "      Nothing has been extracted. Fix the connection and re-run — do NOT untar by hand." >&2
  exit 1
fi

erasure_count=0
if [[ -n "$erasure_keys" ]]; then
  erasure_count="$(printf '%s\n' "$erasure_keys" | grep -c . || true)"
fi
echo "    $erasure_count object key(s) must not come back"

# Validate every key BEFORE extraction too. These come from our own database, but this script
# deletes files by joining them onto a path — an absolute key, or one containing `..`, would delete
# outside the storage root. Checked here, where the answer is still "exit, having changed nothing".
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  case "$key" in
    /*|*..*)
      echo "FAIL: refusing to act on an unsafe object key: $key" >&2
      echo "      Keys are stored relative to the audio root; this one escapes it." >&2
      exit 1
      ;;
  esac
done <<< "$erasure_keys"

# ── 3. Extract ──────────────────────────────────────────────────────────────────────────────────
mkdir -p "$target"
echo "==> restoring $archive into $target"
started="$(date +%s)"
# Decrypted STRAIGHT into tar. Unlike the database restore — where pg_restore's seeking forces a
# temporary plaintext file — tar reads a stream happily, so a decrypted archive of children's
# recordings never exists on disk at all, in either direction.
if backup_crypto_is_encrypted "$archive"; then
  backup_crypto_decrypt_stream "$archive" | tar -xz -C "$target"
else
  tar -xzf "$archive" -C "$target"
fi
restored_count="$(find "$target" -type f | wc -l | tr -d ' ')"
echo "    $restored_count file(s) on disk"

# ── 4. Re-apply erasures — mandatory ────────────────────────────────────────────────────────────
echo "==> re-applying erasures"
reapplied=0
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  path="$target/$key"
  if [[ -f "$path" ]]; then
    rm -f "$path"
    reapplied=$((reapplied + 1))
    echo "    erased again: $key"
  fi
  # A key that is NOT present is the normal case — the backup predates nothing, or the file was
  # already gone when it was taken. Silence there is correct; it is the present ones that matter.
done <<< "$erasure_keys"

final_count="$(find "$target" -type f | wc -l | tr -d ' ')"
elapsed="$(( $(date +%s) - started ))"

# ── 5. Prove it, rather than assert it ──────────────────────────────────────────────────────────
still_present=""
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  [[ -f "$target/$key" ]] && still_present="$still_present$key"$'\n'
done <<< "$erasure_keys"

if [[ -n "$still_present" ]]; then
  echo "FAIL: erased audio survived the restore:" >&2
  printf '%s' "$still_present" >&2
  exit 1
fi

echo
echo "OK   restored $restored_count file(s), re-erased $reapplied, $final_count remain (${elapsed}s)"
echo "     Every key in privacy_jobs was checked against the restored tree and is absent."

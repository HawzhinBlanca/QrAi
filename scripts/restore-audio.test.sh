#!/usr/bin/env bash
# Guard tests for scripts/backup-audio.sh and scripts/restore-audio.sh (P4-T2).
#
# The pre-connection guards are covered here, like restore-db.test.sh — they are the safety-critical
# ones and they need no database. The ROUND TRIP, including the erasure re-application that is the
# whole point of P4-T2, needs live Postgres and runs in the DB-gated block of verify.sh (see the
# ERASURE_DATABASE_URL section at the bottom, which skips loudly rather than silently).
#
#   bash scripts/restore-audio.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
backup="$here/backup-audio.sh"
restore="$here/restore-audio.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
check() { # check <name> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s (expected exit %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}
check_true() { # check_true <name> <condition-result>
  if [[ "$2" == "0" ]]; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s\n' "$1"; fail=$((fail + 1))
  fi
}

echo "scripts/backup-audio.sh"

# 1. No source, and a plausible AUDIO_STORAGE_DIR must NOT be used as a fallback. Same rule, and the
#    same reason, as restore-db.sh's RESTORE_TARGET_URL: a fallback turns a drill into data loss.
mkdir -p "$tmp/decoy"
( AUDIO_STORAGE_DIR="$tmp/decoy" bash "$backup" >/dev/null 2>&1 )
check "refuses without AUDIO_BACKUP_SOURCE, ignoring AUDIO_STORAGE_DIR" 2 "$?"

# 2. A source that does not exist — a typo caught before anything is written.
( AUDIO_BACKUP_SOURCE="$tmp/nope" bash "$backup" >/dev/null 2>&1 )
check "refuses a missing source directory" 2 "$?"

echo
echo "scripts/restore-audio.sh"

src="$tmp/audio"
mkdir -p "$src/tenant-a/learner-1"
printf 'audio-one' > "$src/tenant-a/learner-1/chunk-1.bin"
printf 'audio-two' > "$src/tenant-a/learner-1/chunk-2.bin"
AUDIO_BACKUP_SOURCE="$src" bash "$backup" "$tmp/backups" >/dev/null 2>&1
archive="$(find "$tmp/backups" -name 'audio-storage-*.tar.gz' | head -1)"
check_true "backup produced an archive" "$([[ -f "$archive" ]] && echo 0 || echo 1)"

# 3. No archive argument.
( bash "$restore" >/dev/null 2>&1 )
check "refuses with no archive argument" 2 "$?"

# 4. Archive that does not exist.
( bash "$restore" "$tmp/nope.tar.gz" >/dev/null 2>&1 )
check "refuses a missing archive" 2 "$?"

# 5. No target, and AUDIO_STORAGE_DIR must not stand in for one.
( AUDIO_STORAGE_DIR="$tmp/decoy" ERASURE_DATABASE_URL="postgresql://x" bash "$restore" "$archive" >/dev/null 2>&1 )
check "refuses without AUDIO_RESTORE_TARGET" 2 "$?"

# 6. THE rule this task exists for: no database, no restore.
#    A restore that proceeds without the erasure list resurrects audio a learner asked to have
#    deleted. DATABASE_URL is set to something plausible to prove it is not silently used.
( AUDIO_RESTORE_TARGET="$tmp/out6" DATABASE_URL="postgresql://looks-real/quran_ai" \
    bash "$restore" "$archive" >/dev/null 2>&1 )
check "refuses without ERASURE_DATABASE_URL, ignoring DATABASE_URL" 2 "$?"
check_true "and extracted nothing" "$([[ ! -d "$tmp/out6" ]] && echo 0 || echo 1)"

# 7. An unreachable database fails BEFORE extraction. This is the ordering the whole design rests
#    on: read the erasure list first, so a failure leaves the audio still gone rather than back.
( AUDIO_RESTORE_TARGET="$tmp/out7" ERASURE_DATABASE_URL="postgresql://127.0.0.1:1/nothing" \
    bash "$restore" "$archive" >/dev/null 2>&1 )
check "fails on an unreachable database" 1 "$?"
restored7="$(find "$tmp/out7" -type f 2>/dev/null | wc -l | tr -d ' ')"
check_true "and extracted nothing (the audio stays gone, not back)" \
  "$([[ "$restored7" == "0" ]] && echo 0 || echo 1)"

# 8. Non-empty target is refused without RESTORE_FORCE — checked before the DB, so this needs none.
mkdir -p "$tmp/out8/tenant-a"
printf 'live' > "$tmp/out8/tenant-a/existing.bin"
( AUDIO_RESTORE_TARGET="$tmp/out8" ERASURE_DATABASE_URL="postgresql://127.0.0.1:1/nothing" \
    bash "$restore" "$archive" >/dev/null 2>&1 )
check "refuses a non-empty target without RESTORE_FORCE" 3 "$?"

# 9. There is NO way to skip erasure re-application. An escape hatch would be reached for at 3am by
#    whoever was under the most pressure to get the service back, which is exactly the wrong moment.
#
#    Matched on tokens a bypass would actually be SPELLED as, not the English words for one: the
#    first version of this check matched the comment in restore-audio.sh explaining that no such
#    hatch exists, so the guard passed on prose and would have passed on a real one.
if grep -qE 'SKIP_ERASURE|NO_ERASURE|ERASURE_OPTIONAL|--(skip|no)-erasure' "$restore"; then
  printf '  FAIL restore-audio.sh has an erasure escape hatch\n'; fail=$((fail + 1))
else
  printf '  ok   no flag can skip erasure re-application\n'; pass=$((pass + 1))
fi

# ── The round trip, which is the actual P4-T2 acceptance ────────────────────────────────────────
echo
echo "round trip (needs live Postgres)"
read -ra psql_cmd <<< "${PSQL_BIN:-psql}"
if [[ -n "${DATABASE_URL:-}" ]] && command -v "${psql_cmd[0]}" >/dev/null 2>&1 &&
   "${psql_cmd[@]}" "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
  # A file that exists in the backup and has since been erased. `chunk-2.bin` is the one the learner
  # asked to have deleted; `chunk-1.bin` is the control that proves the restore restored anything at
  # all — without it, "the erased file is absent" is also true of a restore that did nothing.
  # Unique per run, and ON CONFLICT DO NOTHING would be WRONG here: a silently-skipped insert leaves
  # the erasure list empty, the restore then legitimately brings the file back, and the assertion
  # below fails pointing at the restore instead of at the fixture. That happened — the suite passed
  # standalone and failed under verify.sh, and the difference was a seed nobody checked.
  job_id="restore-audio-test-$$-$RANDOM"
  audit_id="audit-$job_id"
  # `set_config('app.tenant_id', ...)` — the tenant context every RLS policy reads (0003_tenant_rls).
  # Without it these INSERTs violate the policy, which is RLS working: the first version of this
  # seed passed for me and failed under verify.sh, and the difference was whether the connecting
  # role happened to bypass RLS. Setting the context makes the fixture behave like the application
  # does rather than like a superuser.
  seed_err="$("${psql_cmd[@]}" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q 2>&1 <<SQL
BEGIN;
SELECT set_config('app.tenant_id', 'hikmah-pilot-erbil', true);
INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
  VALUES ('$audit_id', 'hikmah-pilot-erbil', 'ops-1', 'test.seed', 'privacy_job', '$job_id');
INSERT INTO privacy_jobs (id, tenant_id, learner_id, kind, audio_object_keys_deleted, audit_event_id)
  VALUES ('$job_id', 'hikmah-pilot-erbil', 'learner-1', 'delete',
          '["tenant-a/learner-1/chunk-2.bin"]'::jsonb, '$audit_id');
COMMIT;
SQL
)"
  seed_rc=$?
  check "the fixture privacy_jobs row was created" 0 "$seed_rc"
  [[ $seed_rc -ne 0 ]] && echo "       psql said: $seed_err"

  # And that the RESTORE will actually see it — a row this query cannot read (RLS, a different
  # database behind the same-looking URL) makes every assertion below meaningless.
  visible="$("${psql_cmd[@]}" "$DATABASE_URL" -Atq -c \
    "SELECT set_config('app.tenant_id','hikmah-pilot-erbil',false);
     SELECT count(*) FROM privacy_jobs WHERE id = '$job_id'" 2>/dev/null | tail -1)"
  check_true "and the erasure query can read it back" \
    "$([[ "$visible" == "1" ]] && echo 0 || echo 1)"

  out="$tmp/out-roundtrip"
  AUDIO_RESTORE_TARGET="$out" ERASURE_DATABASE_URL="$DATABASE_URL" \
    bash "$restore" "$archive" >"$tmp/roundtrip.log" 2>&1
  rc=$?

  # WHICH assertion applies depends on the connecting role, and both are real.
  #
  # verify.sh connects as `quran_ai_app` — a non-superuser application role. Under it, RLS scopes
  # privacy_jobs to one tenant and `app.bypass_rls` is ignored (0012), so the erasure list would come
  # back EMPTY and the restore would put every deleted recording back while reporting success. That
  # is the single worst outcome this task exists to prevent, so under that role the correct
  # behaviour is a REFUSAL — and that is what is asserted.
  #
  # This branch is not a convenience. It is the case a real operator hits, and the reason the first
  # version of this script was wrong: it passed for me as a superuser and would have resurrected
  # erased audio in a deployment.
  superuser="$("${psql_cmd[@]}" "$DATABASE_URL" -Atq -c \
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" 2>/dev/null | tail -1)"

  if [[ "$superuser" == "t" ]]; then
    check "round trip succeeds (superuser: cross-tenant reads available)" 0 "$rc"
    check_true "the control file came back (the restore did restore)" \
      "$([[ -f "$out/tenant-a/chunk-1.bin" || -f "$out/tenant-a/learner-1/chunk-1.bin" ]] && echo 0 || echo 1)"
    check_true "the ERASED file did NOT come back" \
      "$([[ ! -f "$out/tenant-a/learner-1/chunk-2.bin" ]] && echo 0 || echo 1)"
  else
    check "REFUSES under a non-superuser role instead of restoring blind" 1 "$rc"
    check_true "and extracted nothing — erased audio was not resurrected" \
      "$([[ ! -f "$out/tenant-a/learner-1/chunk-2.bin" ]] && echo 0 || echo 1)"
    if grep -q "cannot read across tenants" "$tmp/roundtrip.log"; then
      printf '  ok   and said why, naming the role\n'; pass=$((pass + 1))
    else
      printf '  FAIL the refusal did not explain itself:\n'; sed 's/^/         /' "$tmp/roundtrip.log"
      fail=$((fail + 1))
    fi
    echo "  NOTE  connected as a non-superuser; the full round trip is proven in"
    echo "        specs/dr-rehearsal/evidence/T2-audio-drill.log, which runs as one."
  fi

  "${psql_cmd[@]}" "$DATABASE_URL" -q >/dev/null 2>&1 <<SQL
BEGIN;
SELECT set_config('app.tenant_id', 'hikmah-pilot-erbil', true);
DELETE FROM privacy_jobs WHERE id = '$job_id';
DELETE FROM audit_events WHERE id = '$audit_id';
COMMIT;
SQL
else
  echo "  SKIP — no reachable Postgres client for \$DATABASE_URL."
  echo "         The guards above passed; the erasure re-application is UNPROVEN in THIS run."
  echo "         CI has psql and a live database, so the round trip runs there — a local skip is"
  echo "         not a pass, and 'done' is verify.sh green AND CI green (AGENTS.md)."
  echo "         To run it here where Postgres is in Docker:"
  echo "           PSQL_BIN=\"docker exec -i <container> psql\" \\"
  echo "           DATABASE_URL=postgresql://<user>@127.0.0.1:5432/quran_ai \\"
  echo "             bash scripts/restore-audio.test.sh"
fi

echo
echo "  $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]

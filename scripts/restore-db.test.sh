#!/usr/bin/env bash
# Guard tests for scripts/restore-db.sh (P4-T1).
#
# These cover the checks that run BEFORE any database connection, which is deliberate: they are the
# safety-critical ones. The most important is the RESTORE_TARGET_URL rule — verify.sh:28 exports a
# default DATABASE_URL pointing at a real local database, so a restore script that fell back to it
# would overwrite a developer's own data during what they believed was a drill.
#
# The post-connection checks (non-empty-target refusal, row-count verification) need a live Postgres
# and are exercised by the drill in specs/dr-rehearsal/evidence/, not here.
#
#   bash scripts/restore-db.test.sh
set -uo pipefail

script="$(dirname "$0")/restore-db.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dump="$tmp/fake.dump"
head -c 2048 /dev/zero > "$dump"

pass=0
fail=0
check() { # check <name> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s (expected exit %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}

# 1. No dump argument at all.
( bash "$script" >/dev/null 2>&1 )
check "refuses with no dump argument" 2 "$?"

# 2. Dump file that does not exist — catches a typo'd path before touching a database.
( bash "$script" "$tmp/nope.dump" >/dev/null 2>&1 )
check "refuses a missing dump file" 2 "$?"

# 3. THE safety rule: no target, and DATABASE_URL must NOT be used as a fallback.
#    DATABASE_URL is deliberately SET here to a plausible-looking database. A script that fell back
#    to it would proceed; this one must still refuse.
( DATABASE_URL="postgresql://hawzhin@localhost:5432/quran_ai" bash "$script" "$dump" >/dev/null 2>&1 )
check "refuses when RESTORE_TARGET_URL is unset, even with DATABASE_URL set" 2 "$?"

# 4. The refusal must NAME the variable, or an operator cannot fix it at 3am.
out="$( bash "$script" "$dump" 2>&1 )"
if grep -q "RESTORE_TARGET_URL" <<<"$out"; then
  printf '  ok   %s\n' "the refusal names the required variable"; pass=$((pass + 1))
else
  printf '  FAIL %s\n' "the refusal does not name RESTORE_TARGET_URL"; fail=$((fail + 1))
fi

# 5. Source-level assertion: the script must never grow a fallback to DATABASE_URL. This is the
#    exact regression that would silently reintroduce the hazard, and it would not be caught by a
#    behavioural test once someone "helpfully" adds the default back.
if grep -qE 'RESTORE_TARGET_URL:-.*DATABASE_URL' "$script"; then
  printf '  FAIL %s\n' "restore-db.sh has a DATABASE_URL fallback — the hazard is back"; fail=$((fail + 1))
else
  printf '  ok   %s\n' "no DATABASE_URL fallback exists in the script"; pass=$((pass + 1))
fi

# 6. THE SUCCESS PATH — which nothing above reaches.
#
# Every assertion before this one is a REFUSAL, and each refusal exits explicitly. That left the
# script's normal, successful exit completely untested, and a real bug lived in the gap: the
# decrypted-dump cleanup trap was written as
#
#     cleanup() { [[ -n "$decrypted_tmp" && -f "$decrypted_tmp" ]] && rm -f "$decrypted_tmp"; }
#
# whose last command is FALSE whenever there is no temp file — an unencrypted dump, or an encrypted
# one whose decrypt never ran. On an EXIT trap bash adopts that status, so a restore that fully
# succeeded, verified every row count, and printed "RESTORE OK" exited 1.
#
# `pg_restore` and `psql` are stubbed so this runs on any host, including one with no Postgres
# client. That is the point: this tests the SCRIPT's control flow, which is what this file is for.
# Whether a real restore actually recovers real rows is the drill's job
# (specs/dr-rehearsal/evidence/), and stubbing here does not weaken that.
stub_bin="$tmp/stub"
mkdir -p "$stub_bin"
cat > "$stub_bin/pg_restore" <<'STUB'
#!/bin/sh
exit 0
STUB
# Answers the canary check with 0 rows (a fresh target, so no RESTORE_FORCE needed) and every
# verification count with exactly what restore-db.sh requires.
cat > "$stub_bin/psql" <<'STUB'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *canonical_surahs*) echo 114; exit 0 ;;
    *canonical_ayahs*)  echo 6236; exit 0 ;;
    *canonical_words*)  echo 82456; exit 0 ;;
    *count*)            echo 0; exit 0 ;;
  esac
done
echo 0
STUB
chmod +x "$stub_bin/pg_restore" "$stub_bin/psql"

cat > "$tmp/noop-migrate.mjs" <<'STUB'
process.stdout.write('{"applied":0,"adopted":0,"total":26}\n');
STUB
cat > "$tmp/noop-provision.mjs" <<'STUB'
process.stdout.write('{"roleName":"quran_ai_app","restricted":true}\n');
STUB

restore_out="$(PATH="$stub_bin:$PATH" RESTORE_TARGET_URL="postgresql://stub/quran_ai_restored" \
  RESTORE_APP_DATABASE_PASSWORD="restore-test-password-long" \
  MIGRATION_RUNNER="$tmp/noop-migrate.mjs" ROLE_PROVISIONER="$tmp/noop-provision.mjs" \
  bash "$script" "$dump" 2>&1)"
restore_rc=$?
check "a successful restore exits 0 (the cleanup trap must not change the status)" 0 "$restore_rc"

if grep -q "RESTORE OK" <<<"$restore_out"; then
  printf '  ok   %s\n' "and reports RESTORE OK"; pass=$((pass + 1))
else
  printf '  FAIL %s\n' "a restore that exited 0 did not report RESTORE OK:"; fail=$((fail + 1))
  sed 's/^/         /' <<<"$restore_out"
fi

# The other direction, so the assertion above cannot be satisfied by a script that always exits 0:
# when pg_restore FAILS, that failure must still surface.
cat > "$stub_bin/pg_restore" <<'STUB'
#!/bin/sh
echo "pg_restore: error: simulated failure" >&2
exit 1
STUB
( PATH="$stub_bin:$PATH" RESTORE_TARGET_URL="postgresql://stub/quran_ai_restored" \
  RESTORE_APP_DATABASE_PASSWORD="restore-test-password-long" \
  MIGRATION_RUNNER="$tmp/noop-migrate.mjs" ROLE_PROVISIONER="$tmp/noop-provision.mjs" \
  bash "$script" "$dump" >/dev/null 2>&1 )
check "a FAILED pg_restore still exits non-zero (no masking by the trap)" 1 "$?"

echo ""
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]

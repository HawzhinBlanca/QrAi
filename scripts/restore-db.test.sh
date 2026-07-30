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

echo ""
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]

#!/usr/bin/env bash
# PAR4 — prove the parity suite FAILS when the behaviour it guards is broken.
# specs/api-parity-suite/plan.md §5
#
#   DATABASE_URL=postgresql://... bash scripts/verify-parity-teeth.sh
#
# ── Why this exists ─────────────────────────────────────────────────────────────────────────────
# A ported test that passes proves the assertion was TRANSCRIBED, not that it is EQUIVALENT to the
# Rust original. A transcription that quietly weakens an assertion — `status >= 400` where the
# original demanded exactly 403 — passes forever and protects nothing. It is invisible in review and
# invisible in a green run. Nothing else in this phase can catch it.
#
# So: start the service deliberately broken, and require the NAMED tests to go red. A mutation that
# changes nothing is itself a failure — it means that test never had teeth.
#
# Precedent: Phase 4 truncated a table to prove the restore verification checked row counts; Phase 5's
# differ tests are mostly must-fail cases.
set -uo pipefail

: "${DATABASE_URL:?set DATABASE_URL — this needs the same live Postgres the suite uses}"

fail=0
say() { printf '\n==> %s\n' "$1"; }

# ── Guard: the RLS mutation is HOLLOW unless DATABASE_URL connects as a superuser ────────────────
# `rls-no-role-drop` works by making `SET LOCAL ROLE` a no-op, so the probe runs as whoever
# connected. If that identity is already restricted, RLS still enforces, the test still passes, and
# this script would report "teeth verified" having verified nothing. Refuse instead.
say "precondition: DATABASE_URL must be a superuser for the RLS mutation to mean anything"
is_super="$(node -e '
  const pg = require("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c.connect()
    .then(() => c.query("SELECT rolsuper OR rolbypassrls AS s FROM pg_roles WHERE rolname = current_user"))
    .then((r) => { console.log(r.rows[0]?.s ? "yes" : "no"); return c.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
')" || exit 1

if [[ "$is_super" != "yes" ]]; then
  echo "    ✗ DATABASE_URL connects as a RESTRICTED role." >&2
  echo "      The rls-no-role-drop mutation cannot weaken anything from there, so a pass would be" >&2
  echo "      hollow. Re-run with a superuser DATABASE_URL (this is what CI uses)." >&2
  exit 1
fi
echo "    ok  connected as a superuser — dropping to quran_ai_app is a real privilege change"

# expect_fail <mutation> <test-file> <test name that MUST go red>
expect_fail() {
  local mutation="$1" file="$2" name="$3"
  say "mutation '${mutation}' must break: ${name}"

  local out
  out="$(PARITY_MUTATE="$mutation" node --test "$file" 2>&1)"

  if grep -qF "not ok" <<<"$out" && grep -qF "$name" <<<"$out"; then
    # Confirm THIS test failed, not merely that something did — a startup crash would otherwise
    # count as proof for every mutation.
    if grep -E "^not ok [0-9]+ - .*$(printf '%s' "$name" | sed 's/[][\.*^$/]/\\&/g')" <<<"$out" >/dev/null; then
      echo "    ok  went red as required"
      return
    fi
  fi

  echo "    ✗ TEETHLESS — '${name}' did NOT fail under mutation '${mutation}'." >&2
  echo "      Either the mutation is ineffective, or the assertion does not actually check the" >&2
  echo "      behaviour it claims to. Both are defects." >&2
  printf '%s\n' "$out" | grep -E "^(ok|not ok)" | sed 's/^/      /' >&2
  fail=1
}

PARITY_DIR="tests/api-parity"

expect_fail "header-auth-on" "$PARITY_DIR/auth-disabled.test.mjs" \
  "spoofed x-user-role headers are rejected when header auth is OFF"

expect_fail "rls-no-role-drop" "$PARITY_DIR/default.test.mjs" \
  "RLS backstops a query that forgets its tenant context entirely"

expect_fail "rls-no-role-drop" "$PARITY_DIR/default.test.mjs" \
  "hostile SQL under another tenant's context reads nothing and cannot insert"

expect_fail "cors-permissive" "$PARITY_DIR/cors.test.mjs" \
  "a disallowed Origin gets no access-control-allow-origin header"

expect_fail "metrics-dev-open" "$PARITY_DIR/metrics.test.mjs" \
  "/metrics is CLOSED when neither a token nor dev mode is set"

# ── The other half: unmutated, everything must be green ──────────────────────────────────────────
# Without this, a suite that failed unconditionally would satisfy every check above.
say "control: with no mutation, the whole suite must pass"
if node --test "$PARITY_DIR"/*.test.mjs "$PARITY_DIR"/lib/*.test.mjs >/dev/null 2>&1; then
  echo "    ok  clean run is green"
else
  echo "    ✗ the unmutated suite is RED — the mutation results above prove nothing." >&2
  fail=1
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "PARITY TEETH FAILED" >&2
  exit 1
fi
echo "PARITY TEETH OK — every mutation produced its named failure, and the clean run is green"

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

# ── Retry the CONNECTION, never the ANSWER ──────────────────────────────────────────────────────
# A single refused connection once took an entire `verify` job down, under this superuser-titled
# heading — so the failure read as a role problem when it was a socket problem, and the first
# diagnosis chased the wrong thing entirely.
#
# What is retried is strictly the ability to REACH Postgres. If the database answers and says the
# role is restricted, that is final and is not retried: a guard that kept asking until it liked the
# answer would be worse than the flake. The two outcomes are also reported separately, because
# "could not connect" and "connected, wrong role" need opposite fixes and only one of them is about
# a superuser.
probe_superuser() {
  node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    c.connect()
      .then(() => c.query("SELECT rolsuper OR rolbypassrls AS s FROM pg_roles WHERE rolname = current_user"))
      .then((r) => { console.log(r.rows[0]?.s ? "yes" : "no"); return c.end(); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  '
}

TEETH_CONNECT_ATTEMPTS="${TEETH_CONNECT_ATTEMPTS:-5}"
probe_err="$(mktemp)"
trap 'rm -f "$probe_err"' EXIT
is_super=""
for attempt in $(seq 1 "$TEETH_CONNECT_ATTEMPTS"); do
  if is_super="$(probe_superuser 2>"$probe_err")"; then
    break
  fi
  is_super=""
  if [[ "$attempt" -lt "$TEETH_CONNECT_ATTEMPTS" ]]; then
    echo "    ...could not reach Postgres (attempt ${attempt}/${TEETH_CONNECT_ATTEMPTS}), retrying" >&2
    sleep 2
  fi
done

if [[ -z "$is_super" ]]; then
  echo "    ✗ could not REACH Postgres at \$DATABASE_URL after ${TEETH_CONNECT_ATTEMPTS} attempts." >&2
  echo "      This is a connectivity failure, NOT the superuser check below — the role was never" >&2
  echo "      asked. The driver said:" >&2
  sed 's/^/        /' "$probe_err" >&2
  exit 1
fi

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
# --test-concurrency=1 for the same reason scripts/verify.sh serializes this suite: every file
# shares ONE database and `assertAB` issues its two requests concurrently, so a row another file
# inserts between them fails the comparison on DATA rather than on behaviour. Measured, 3 runs:
# concurrent -> 3 failures, a different test each time; serialized -> clean.
#
# This line was missed when verify.sh was fixed, and CI caught it — the mutation loop above runs one
# file at a time so it was never affected, while this control run globs all of them.
say "control: with no mutation, the whole suite must pass"
control_out="$(node --test --test-concurrency=1 "$PARITY_DIR"/*.test.mjs "$PARITY_DIR"/lib/*.test.mjs 2>&1)"
if [[ $? -eq 0 ]]; then
  echo "    ok  clean run is green"
else
  # Print WHY. The previous version discarded stdout and stderr, so a red control run cost a full
  # CI round-trip to diagnose — the failing test name was never reported anywhere.
  echo "    ✗ the unmutated suite is RED — the mutation results above prove nothing." >&2
  printf '%s\n' "$control_out" | grep -E "^not ok [0-9]+ - |^# (pass|fail)" >&2 || true
  fail=1
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "PARITY TEETH FAILED" >&2
  exit 1
fi
echo "PARITY TEETH OK — every mutation produced its named failure, and the clean run is green"

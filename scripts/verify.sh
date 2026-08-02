#!/usr/bin/env bash
# CODYSTEM verify gate for quran-ai-platform — the single source of "does it work".
# CI runs this SAME script (.github/workflows/ci.yml), so local == CI.
#
#   bash scripts/verify.sh           full gate: guard + lint + typecheck + test + build
#   bash scripts/verify.sh --fast    lint + typecheck only (used by the PostToolUse hook)
#   bash scripts/verify.sh --release release gate: full gate + required live DB + full-stack smoke
#
# Polyglot: TS (web/contracts/quran-data via pnpm) + Rust (gateway/platform-api via cargo).
# DB-dependent platform-api integration tests run ONLY when a live Postgres is reachable —
# they are SKIPPED (never faked) otherwise. This script never prints a false "VERIFY OK".
set -uo pipefail

MODE="${1:-}"
case "$MODE" in
  "") FAST="no"; RELEASE="no" ;;
  --fast) FAST="yes"; RELEASE="no" ;;
  --release) FAST="no"; RELEASE="yes" ;;
  *)
    echo "usage: bash scripts/verify.sh [--fast|--release]" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export DATABASE_URL="${DATABASE_URL:-postgresql://hawzhin@localhost:5432/quran_ai}"

GW="services/realtime-gateway/Cargo.toml"
API="services/platform-api/Cargo.toml"

# Optional, git-ignored per-machine overrides (e.g. custom DATABASE_URL).
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "${_here}/stack.env" ]]; then
  # shellcheck disable=SC1091
  source "${_here}/stack.env"
fi

# A release verification must never quietly run against a developer's default
# database or emit its proof into the candidate checkout. The caller supplies a
# dedicated, disposable release DB and external artifact destinations; CI is
# responsible for making those inputs isolated and protected.
if [[ "$RELEASE" == "yes" ]]; then
  required_release_vars=(
    RELEASE_DATABASE_URL
    RELEASE_SMOKE_ARTIFACT_DIR
    RELEASE_SMOKE_TRACE_ID
    RELEASE_TEST_SUMMARY
    RELEASE_ENVIRONMENT_SUMMARY
    RELEASE_ENVIRONMENT_CLASS
    RELEASE_ENVIRONMENT_PROVIDER
    RELEASE_IMAGE_DIGESTS_JSON
  )
  for variable in "${required_release_vars[@]}"; do
    if [[ -z "${!variable:-}" ]]; then
      echo "release verification requires $variable" >&2
      exit 2
    fi
  done
  export DATABASE_URL="$RELEASE_DATABASE_URL"
  export SMOKE_ARTIFACT_DIR="$RELEASE_SMOKE_ARTIFACT_DIR"
  export SMOKE_TRACE_ID="$RELEASE_SMOKE_TRACE_ID"
  export SMOKE_CANDIDATE_SHA="$(git rev-parse HEAD)"
  export SMOKE_REQUIRE_CANDIDATE_EVIDENCE="1"
  export SMOKE_IMAGE_DIGESTS_JSON="$RELEASE_IMAGE_DIGESTS_JSON"
  export SMOKE_ENVIRONMENT_CLASS="$RELEASE_ENVIRONMENT_CLASS"
  export SMOKE_ENVIRONMENT_PROVIDER="$RELEASE_ENVIRONMENT_PROVIDER"
  export SMOKE_TEST_ACTOR_CLASS="release-automation"
  if ! node scripts/release-evidence-summary.mjs \
    --validate-only \
    --test-output "$RELEASE_TEST_SUMMARY" \
    --environment-output "$RELEASE_ENVIRONMENT_SUMMARY" \
    --environment-class "$RELEASE_ENVIRONMENT_CLASS" \
    --environment-provider "$RELEASE_ENVIRONMENT_PROVIDER" \
    --smoke-artifact-dir "$RELEASE_SMOKE_ARTIFACT_DIR"; then
    echo "release verification requires clean checkout and external evidence destinations" >&2
    exit 2
  fi
fi

fail=0
say() { printf '\n==> %s\n' "$*"; }
run() { # run <name> <shell-command>
  local name="$1" cmd="$2"
  say "$name"
  if ! bash -c "$cmd"; then
    echo "    ✗ ${name} failed" >&2
    fail=1
  fi
}

# --- 0. Guard: no tracked secrets / protected files (anti-leak boundary) ------
# Allow template files (.env.example/.sample/.template) — they hold no real secrets.
say "guard: tracked secrets & protected paths"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  leaked="$(git ls-files \
    | grep -E '(^|/)\.env$|(^|/)\.env\.|(^|/)secrets/|\.pem$' \
    | grep -vE '(^|/)\.env\.(example|sample|template)$' || true)"
  if [[ -n "$leaked" ]]; then
    echo "    ✗ secret/protected file(s) tracked — untrack them (see AGENTS.md):" >&2
    printf '        %s\n' $leaked >&2
    fail=1
  fi
fi

# --- 1. Lint (Rust fmt + clippy; TS "lint" == typecheck, run below) -----------
run "lint: rust fmt"    "cargo fmt --manifest-path $GW --check && cargo fmt --manifest-path $API --check"
run "lint: rust clippy" "cargo clippy --manifest-path $GW -- -D warnings && cargo clippy --manifest-path $API -- -D warnings"

# --- 2. Typecheck (TS workspaces) ---------------------------------------------
run "typecheck: ts" "pnpm --filter @quran-ai/contracts typecheck && pnpm --filter @quran-ai/quran-data typecheck && pnpm --filter @quran-ai/web typecheck"

if [[ "$FAST" != "yes" ]]; then
  # --- 3. Test --------------------------------------------------------------
  run "test: ts"                  "pnpm --filter @quran-ai/contracts test && pnpm --filter @quran-ai/quran-data test && pnpm --filter @quran-ai/web test"
  # Node services (ml-inference, agents) have no pnpm workspace; run their hermetic
  # node:test suites by explicit path. server.mjs gates its side effects (listen/timers) on
  # `isMain`, so server.test.mjs can import it directly; keep explicit paths (a dir glob would
  # still pick up non-test .mjs files).
  # PAR6: tests/api-parity/coverage.test.mjs belongs HERE, not in the DB-gated block below. It only
  # reads integration.rs + coverage.json, so "is every Rust test accounted for" has nothing to do
  # with Postgres. The parity suite ITSELF is DB- and binary-gated further down.
  run "test: node services"       "node --test scripts/fixture-normalize.test.mjs scripts/diff-api-fixtures.test.mjs scripts/fixture-coverage.test.mjs services/ml-inference/alignment.test.mjs services/ml-inference/marks-parity.test.mjs services/ml-inference/tajweed.test.mjs services/ml-inference/server.test.mjs services/agents/agents.test.mjs scripts/release-manifest.test.mjs scripts/release-build-evidence.test.mjs scripts/release-evidence-summary.test.mjs scripts/smoke-evidence.test.mjs scripts/smoke-database.test.mjs scripts/release-images.test.mjs tests/api-parity/coverage.test.mjs tests/node-api/ticket-vectors.test.mjs tests/node-api/authz.test.mjs tests/node-api/shell.test.mjs tests/node-api/routes-table.test.mjs tests/node-api/metrics-render.test.mjs tests/node-api/rust-json.test.mjs tests/node-api/no-secret-logging.test.mjs tests/node-api/boot-guard.test.mjs tests/contract/coverage.test.mjs tests/contract/cutover-readiness.test.mjs tests/contract/boundary-references.test.mjs tests/contract/flutter-contract.test.mjs tests/contract/enum-parity.test.mjs tests/contract/tajweed-gate-parity.test.mjs tests/i18n/registers.test.mjs tests/i18n/locale-parity.test.mjs tests/i18n/drafts.test.mjs tests/security/legacy-insecure-flag.test.mjs"
  # apps/mobile is NOT a pnpm workspace member, so the TS `test: ts` line above never covered it and
  # its consent/auth/audio-format helpers went unguarded (a real audioFormat bug shipped there). The
  # helpers import ONLY node builtins, so this needs no install — just Node's type-stripping to read
  # the .ts directly. Same explicit-path style as the node services line above.
  run "test: mobile"              "node --experimental-strip-types --test apps/mobile/lib/session.test.ts"

  # FL1/FL2 — the Flutter client. SKIPPED, loudly, when the SDK is absent: it is a 2.1 GB user-space
  # install and neither CI nor a fresh clone has it, so making it mandatory would turn every other
  # machine's verify.sh red for a reason unrelated to the change under test. `--fatal-infos` is
  # deliberate — the analyzer's `info` tier is where `avoid_dynamic_calls` and `unawaited_futures`
  # live, and both are ways canonical text or a credential goes wrong quietly.
  #
  # This gate covers ANALYSIS and HEADLESS TESTS only. It is not, and must never be reported as,
  # device proof: no Xcode and no Android cmdline-tools on this machine, so FL9's iOS/Android matrix
  # stays open (specs/migration-completion/research.md §1).
  if command -v flutter >/dev/null 2>&1; then
    run "analyze: flutter client"  "cd apps/flutter && flutter pub get --enforce-lockfile >/dev/null && dart analyze --fatal-infos"
    run "test: flutter client"     "cd apps/flutter && flutter test"
  else
    say "analyze + test: flutter client"
    echo "    • SKIP — no \`flutter\` on PATH. Install the SDK to include apps/flutter."
  fi

  # P4-T1: restore-db.sh's pre-connection guards. The critical one asserts the script has NO
  # DATABASE_URL fallback — verify.sh (line 28 of this file) exports a default DATABASE_URL pointing
  # at a real local database, so a restore script that fell back to it would overwrite a developer's
  # own data during what they believed was a drill. Pure bash, no DB needed, so it always runs.
  # F2 — the hand-authored OpenAPI contract validated against the COMMITTED Phase 5 fixtures, which
  # were themselves captured from a live service. Hermetic (reads JSON, starts nothing), so it
  # belongs here and not in the DB-gated block. A spec that has never met a real response is
  # documentation; this is what makes it a contract.
  run "contract: openapi vs real responses" "node scripts/validate-openapi-responses.mjs"
  # CU1 — cutover readiness, printed for the record. INFORMATIONAL: it must never fail the gate,
  # because "not ready to cut over" is the correct and expected state, not a build break. A gate
  # that went red for that would be noise, and noise gets silenced — which is how the one signal
  # that mattered would be lost. Its LOGIC is gated properly, by cutover-readiness.test.mjs above.
  say "cutover readiness (informational)"
  node scripts/cutover-readiness.mjs 2>&1 | sed 's/^/    /' || true
  run "test: restore guards"      "bash scripts/restore-db.test.sh"
  # MIG5 — Python. asr-inference ships plain-interpreter suites (documented as `python test_x.py`)
  # that import no torch and load no model, so they run anywhere Python 3 + numpy exist. They were
  # previously ungated ENTIRELY — including test_forced_align_normalization.py, which guards the
  # diacritic character class that once deleted every Arabic letter and shipped through review
  # (PR #258). Deliberately NOT skip-if-missing: a soft skip would report green on a machine with
  # no Python and hide exactly the class of bug this exists to catch.
  # NOT included: test_audio_guards.py. Its docstring claims plain-interpreter, but it imports
  # fastapi and shells out to ffmpeg (verified: system python3 has numpy but not fastapi), so it
  # needs the service venv. It stays ungated until CI installs the asr-inference requirements —
  # a named gap, not a silent one.
  run "test: python (asr-inference)" "cd services/asr-inference && { command -v python3 >/dev/null || { echo 'python3 not found — required, not optional'; exit 1; }; } && python3 test_eval_metrics.py && python3 test_forced_align_normalization.py && python3 test_force_align_unavailable.py && python3 test_ghunnah_escapes.py"
  # shared-ticket is only ever BUILT as a dependency of the two services, so `cargo test` on them
  # never ran its own 14 tests — including the cross-language ticket vectors, which pin the one
  # credential that crosses a service boundary. Same class of gap as MIG5's ungated Python.
  run "test: rust shared-ticket"  "cargo test --manifest-path services/shared-ticket/Cargo.toml"
  run "test: rust gateway"        "cargo test --manifest-path $GW"
  run "test: rust platform-api"   "cargo test --manifest-path $API"

  # G3 — the gateway's WebSocket surface, against a REAL process. Needs no database, so it belongs
  # here rather than in the DB-gated block below. `cargo build` is explicit for the same reason the
  # parity block gives: `cargo test` above builds the test harness, not the binary this spawns, and
  # every gateway test that already exists drives the router in-process via `oneshot`, which never
  # performs a WebSocket upgrade at all.
  run "test: gateway websocket (real process)" \
    "cargo build --manifest-path $GW && node --test tests/gateway/ws-hostile-input.test.mjs"

  # DB-gated integration tests — only when a live Postgres answers and allows authentication. Skipped, not faked.
  can_auth="no"
  if command -v psql >/dev/null 2>&1; then
    PGCONNECT_TIMEOUT=2 psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1 &
    PSQL_PID=$!
    count=0
    while kill -0 $PSQL_PID 2>/dev/null && [ $count -lt 20 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    if kill -0 $PSQL_PID 2>/dev/null; then
      kill -9 $PSQL_PID 2>/dev/null
      wait $PSQL_PID 2>/dev/null || true
    else
      if wait $PSQL_PID 2>/dev/null; then
        can_auth="yes"
      fi
    fi
  fi

  if [[ "$can_auth" == "yes" ]]; then
    run "test: platform-api integration (live Postgres)" "cargo test --manifest-path $API -- --include-ignored"
    # PAR5 — the cross-language API parity suite (specs/api-parity-suite/). Black-box: it starts the
    # real platform-api binary on an ephemeral port per configuration group and asserts over HTTP +
    # direct SQL. This is the oracle a future Node backend must satisfy.
    #
    # `cargo build` is explicit rather than assumed: `cargo test` above builds the test harness, and
    # a suite that silently skipped on a missing binary would gate nothing (the harness raises
    # instead — see tests/api-parity/lib/harness.mjs).
    #
    # NOT run here: scripts/verify-parity-teeth.sh, which proves each ported assertion FAILS when the
    # behaviour breaks. It requires a SUPERUSER DATABASE_URL (its rls-no-role-drop mutation cannot
    # weaken anything from an already-restricted role, and it refuses to report a hollow pass). CI's
    # DATABASE_URL is deterministic, so CI runs it as its own step — a named boundary, not a gap.
    # --test-concurrency=1 is NOT a performance knob and must not be removed to speed the gate up.
    #
    # These suites all read and write ONE database. `assertAB` issues its two requests concurrently,
    # so any row another file inserts between them makes the comparison fail on data rather than on
    # behaviour. Measured, 5 runs each: concurrent -> 3 failures, a DIFFERENT test every time
    # (audit-events, a pilot cookie lookup, a CSRF gate); serialized -> 5 clean runs of 174.
    #
    # `GET /v1/audit-events` is the clearest case — `ORDER BY created_at DESC LIMIT 200` over a table
    # every authenticated request appends to. That race was latent long before this change; N13's
    # pilot routes simply write enough audit events to surface it several times an hour instead of
    # once a month. A flaky gate is worse than a red one: it teaches everyone to re-run.
    run "test: api parity suite (live Postgres)" \
      "cargo build --manifest-path $API && node --test --test-concurrency=1 tests/api-parity/lib/harness.test.mjs tests/api-parity/default.test.mjs tests/api-parity/auth-disabled.test.mjs tests/api-parity/cors.test.mjs tests/api-parity/metrics.test.mjs tests/api-parity/ml-proxy.test.mjs tests/api-parity/realtime-ticket.test.mjs tests/api-parity/db-endpoints.test.mjs tests/api-parity/proxy-endpoints.test.mjs tests/api-parity/contract-shapes.test.mjs tests/api-parity/hostile-input.test.mjs tests/api-parity/infra-parity.test.mjs tests/api-parity/quran-parity.test.mjs tests/api-parity/progress-parity.test.mjs tests/api-parity/reports-parity.test.mjs tests/api-parity/auth-token-parity.test.mjs tests/api-parity/pilot-auth-parity.test.mjs tests/api-parity/pilot-routes-parity.test.mjs tests/api-parity/sessions-parity.test.mjs tests/api-parity/session-writes-parity.test.mjs tests/api-parity/review-parity.test.mjs tests/api-parity/ml-asr-proxy-parity.test.mjs tests/api-parity/privacy-parity.test.mjs tests/api-parity/agent-write-parity.test.mjs tests/node-api/db-tenant.test.mjs"
  else
    say "test: platform-api integration + api parity suite"
    if [[ "$RELEASE" == "yes" ]]; then
      echo "    ✗ RELEASE FAIL — dedicated release database is unreachable or authentication failed." >&2
      fail=1
    else
      echo "    • SKIP — no live Postgres or authentication failed at \$DATABASE_URL."
      echo "      Run \`docker compose up -d postgres\` (or set DATABASE_URL) to include them."
    fi
  fi

  # --- 4. Build -------------------------------------------------------------
  run "build" "pnpm --filter @quran-ai/contracts build && pnpm --filter @quran-ai/quran-data build && pnpm --filter @quran-ai/web build"
  run "guard: web production bundle secrets" "node scripts/check-web-bundle-secrets.mjs"
  run "guard: web security headers (ADR-0010)" "node scripts/check-security-headers.mjs"

  if [[ "$RELEASE" == "yes" ]]; then
    # smoke:all drives proof, SQL, browser, API, gateway, ML, and privacy
    # surfaces. Its artifact directory and trace are supplied above rather than
    # falling back to out/ or an unbound random value.
    run "test: release full-stack smoke" "pnpm smoke:all"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "VERIFY FAILED" >&2
  exit 1
fi

if [[ "$RELEASE" == "yes" ]]; then
  say "write: candidate-bound release test evidence"
  if ! node scripts/release-evidence-summary.mjs \
    --test-output "$RELEASE_TEST_SUMMARY" \
    --environment-output "$RELEASE_ENVIRONMENT_SUMMARY" \
    --environment-class "$RELEASE_ENVIRONMENT_CLASS" \
    --environment-provider "$RELEASE_ENVIRONMENT_PROVIDER" \
    --smoke-artifact-dir "$RELEASE_SMOKE_ARTIFACT_DIR"; then
    echo "    ✗ failed to write release test evidence" >&2
    exit 1
  fi
fi
echo
echo "VERIFY OK"

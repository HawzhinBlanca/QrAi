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
  run "test: node services"       "node --test services/ml-inference/alignment.test.mjs services/ml-inference/tajweed.test.mjs services/ml-inference/server.test.mjs services/agents/agents.test.mjs scripts/release-manifest.test.mjs scripts/release-build-evidence.test.mjs scripts/release-evidence-summary.test.mjs scripts/smoke-evidence.test.mjs scripts/smoke-database.test.mjs"
  # apps/mobile is NOT a pnpm workspace member, so the TS `test: ts` line above never covered it and
  # its consent/auth/audio-format helpers went unguarded (a real audioFormat bug shipped there). The
  # helpers import ONLY node builtins, so this needs no install — just Node's type-stripping to read
  # the .ts directly. Same explicit-path style as the node services line above.
  run "test: mobile"              "node --experimental-strip-types --test apps/mobile/lib/session.test.ts"
  run "test: rust gateway"        "cargo test --manifest-path $GW"
  run "test: rust platform-api"   "cargo test --manifest-path $API"

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
  else
    say "test: platform-api integration"
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

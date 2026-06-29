#!/usr/bin/env bash
# CODYSTEM verify gate for quran-ai-platform — the single source of "does it work".
# CI runs this SAME script (.github/workflows/ci.yml), so local == CI.
#
#   bash scripts/verify.sh           full gate: guard + lint + typecheck + test + build
#   bash scripts/verify.sh --fast    lint + typecheck only (used by the PostToolUse hook)
#
# Polyglot: TS (web/contracts/quran-data via pnpm) + Rust (gateway/platform-api via cargo).
# DB-dependent platform-api integration tests run ONLY when a live Postgres is reachable —
# they are SKIPPED (never faked) otherwise. This script never prints a false "VERIFY OK".
set -uo pipefail

FAST="${1:-}"

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
say "guard: tracked secrets & protected paths"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files -z | grep -zqE '(^|/)\.env$|(^|/)\.env\.|(^|/)secrets/|\.pem$'; then
    echo "    ✗ a secret/protected file is tracked — untrack it (see AGENTS.md)" >&2
    fail=1
  fi
fi

# --- 1. Lint (Rust fmt + clippy; TS "lint" == typecheck, run below) -----------
run "lint: rust fmt"    "cargo fmt --manifest-path $GW --check && cargo fmt --manifest-path $API --check"
run "lint: rust clippy" "cargo clippy --manifest-path $GW -- -D warnings && cargo clippy --manifest-path $API -- -D warnings"

# --- 2. Typecheck (TS workspaces) ---------------------------------------------
run "typecheck: ts" "pnpm --filter @quran-ai/contracts typecheck && pnpm --filter @quran-ai/quran-data typecheck && pnpm --filter @quran-ai/web typecheck"

if [[ "$FAST" != "--fast" ]]; then
  # --- 3. Test --------------------------------------------------------------
  run "test: ts"                  "pnpm --filter @quran-ai/contracts test && pnpm --filter @quran-ai/quran-data test && pnpm --filter @quran-ai/web test"
  run "test: rust gateway"        "cargo test --manifest-path $GW"
  run "test: rust platform-api"   "cargo test --manifest-path $API"

  # DB-gated integration tests — only when a live Postgres answers. Skipped, not faked.
  if command -v pg_isready >/dev/null 2>&1 && pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
    run "test: platform-api integration (live Postgres)" "cargo test --manifest-path $API -- --include-ignored"
  else
    say "test: platform-api integration"
    echo "    • SKIP — no live Postgres at \$DATABASE_URL."
    echo "      Run \`docker compose up -d postgres\` (or set DATABASE_URL) to include them."
  fi

  # --- 4. Build -------------------------------------------------------------
  run "build" "pnpm --filter @quran-ai/contracts build && pnpm --filter @quran-ai/quran-data build && pnpm --filter @quran-ai/web build"
fi

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "VERIFY FAILED" >&2
  exit 1
fi
echo
echo "VERIFY OK"

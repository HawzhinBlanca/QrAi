#!/usr/bin/env bash
# Flips a tasks.md row to [x] ONLY if scripts/verify.sh passes. The check decides
# "done" — never the agent. Portable across GNU (Linux/CI/devcontainer) and BSD (macOS)
# sed by writing to a temp file instead of relying on `sed -i` suffix semantics.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: scripts/update-ledger.sh <TASK> <TESTS>   (e.g. scripts/update-ledger.sh T1 t-ac1)" >&2
  exit 2
fi
task="$1"; tests="$2"
# Strict allowlist: the task id is interpolated into a sed program below, so reject any
# value with sed-significant or shell-significant characters (e.g. `/`, `;`, spaces).
if [[ ! "$task" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "REFUSED: task id '${task}' must match ^[A-Za-z0-9_.-]+$ (got unexpected characters)." >&2
  exit 2
fi
if bash scripts/verify.sh; then
  for f in specs/*/tasks.md; do
    [ -e "$f" ] || continue
    tmp="$(mktemp)"
    sed "s/- \[ \] ${task} /- [x] ${task} /" "$f" > "$tmp" && mv "$tmp" "$f"
  done
  echo "Ledger updated: ${task} done (tests: ${tests}; verify.sh passed)."
else
  echo "REFUSED: verify.sh failed; ${task} stays open."; exit 1
fi

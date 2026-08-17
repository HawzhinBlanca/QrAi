#!/usr/bin/env bash
# Flips a tasks.md row to [x] ONLY if scripts/verify.sh passes. The check decides
# "done" — never the agent. Portable across GNU (Linux/CI/devcontainer) and BSD (macOS)
# sed by writing to a temp file instead of relying on `sed -i` suffix semantics.
#
# ── What this script may NOT close ──────────────────────────────────────────────────────────────
# `specs/readiness-recovery-10-10/tasks.md` states its own rule at the top:
#
#     Every item stays `[ ]` until its acceptance test, `bash scripts/verify.sh --release`,
#     required CI, a retained candidate-bound artifact, and an independent verifier are recorded.
#
# This script runs a plain local `verify.sh`. It cannot run `--release` (that needs a dedicated
# disposable database and external evidence destinations), it does not see CI, it retains no
# artifact, and it is not an independent verifier. It used to flip rows there anyway — so the
# document governing release readiness had a WRITE PATH WITH WEAKER GUARANTEES THAN THE RULES IT
# RECORDS, and no ledger row owned that fact. It now refuses, and says why.
#
# ── One ledger, not all of them ─────────────────────────────────────────────────────────────────
# The sed used to be sprayed across every `specs/*/tasks.md`, so a task id appearing in two ledgers
# flipped both. Ids are short and reused — `T1` and `P0.1` are not unique across specs. Ambiguity is
# REFUSED rather than resolved by picking one: the same shape as `insecure.rs`'s `legacy_verdict`,
# because silently picking a winner is exactly how something ends up marked done without anyone
# deciding it should be.
#
# The checks below run BEFORE verify.sh, so a refusal costs a second rather than a full gate — and
# so `scripts/update-ledger.test.sh` can exercise every one of them without running the gate.
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
# The ledger whose own rule this script cannot satisfy.
READINESS_LEDGER="specs/readiness-recovery-10-10/tasks.md"

matches=()
for f in specs/*/tasks.md; do
  [ -e "$f" ] || continue
  if grep -qE "^- \[ \] ${task} " "$f"; then
    matches+=("$f")
  fi
done

if [[ ${#matches[@]} -eq 0 ]]; then
  echo "REFUSED: no open row '- [ ] ${task} ' in any specs/*/tasks.md — nothing to close." >&2
  exit 2
fi
if [[ ${#matches[@]} -gt 1 ]]; then
  echo "REFUSED: task id '${task}' matches an open row in ${#matches[@]} ledgers:" >&2
  printf '    %s\n' "${matches[@]}" >&2
  echo "  Task ids are not unique across specs. Closing one would silently close the others," >&2
  echo "  so this refuses rather than picking a winner." >&2
  exit 2
fi

target="${matches[0]}"
if [[ "$target" == "$READINESS_LEDGER" ]]; then
  echo "REFUSED: ${READINESS_LEDGER} states its own rule, and this script cannot meet it." >&2
  echo "  It requires: bash scripts/verify.sh --release, required CI, a retained candidate-bound" >&2
  echo "  artifact, and an INDEPENDENT VERIFIER. This script runs a plain local verify.sh, sees no" >&2
  echo "  CI, retains nothing, and is not independent of whoever asked it to flip the row." >&2
  echo "  Record that evidence in the ledger by hand, under a human accountable for it." >&2
  exit 2
fi

if bash scripts/verify.sh; then
  tmp="$(mktemp)"
  sed "s/- \[ \] ${task} /- [x] ${task} /" "$target" > "$tmp" && mv "$tmp" "$target"
  echo "Ledger updated: ${task} done in ${target} (tests: ${tests}; verify.sh passed)."
else
  echo "REFUSED: verify.sh failed; ${task} stays open."; exit 1
fi

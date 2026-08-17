#!/usr/bin/env bash
# `scripts/update-ledger.sh` refuses what it cannot honestly close.
#
# ── Why this test exists ────────────────────────────────────────────────────────────────────────
# The ledger flipper had no test and no owning row. It ran a plain `verify.sh` and then sprayed
#     sed "s/- \[ \] ${task} /- [x] ${task} /"
# across EVERY specs/*/tasks.md — including specs/readiness-recovery-10-10/tasks.md, whose own rule
# demands `verify.sh --release`, required CI, a retained candidate-bound artifact and an independent
# verifier. The document governing release readiness had a write path with weaker guarantees than
# the rules it records.
#
# Every case below exercises a refusal that happens BEFORE the gate runs, so this whole file costs
# about a second. That ordering is deliberate in the script, and this test is what holds it there:
# if a guard were moved after `bash scripts/verify.sh`, these cases would hang for fifteen minutes
# instead of passing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT"

fail=0
ok()   { printf '    ✓ %s\n' "$1"; }
bad()  { printf '    ✗ %s\n' "$1" >&2; fail=1; }

# A throwaway checkout so the real ledgers are never touched. `specs/*/tasks.md` is the glob the
# script walks, so the fixture only needs that shape.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/scripts" "$work/specs/alpha" "$work/specs/beta" "$work/specs/readiness-recovery-10-10"
cp scripts/update-ledger.sh "$work/scripts/"
# A verify.sh that would PASS instantly. If any refusal below leaked past its guard and reached the
# gate, the row would flip and the assertion would catch it — the fixture cannot mask a missing
# guard, it only makes the test fast.
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/scripts/verify.sh"
chmod +x "$work/scripts/verify.sh"

printf -- '- [ ] T1 — alpha row\n- [ ] SHARED — alpha copy\n' > "$work/specs/alpha/tasks.md"
printf -- '- [ ] T2 — beta row\n- [ ] SHARED — beta copy\n' > "$work/specs/beta/tasks.md"
printf -- '- [ ] P0.1 — Assign release authority and publish the decision matrix.\n' \
  > "$work/specs/readiness-recovery-10-10/tasks.md"

run() { ( cd "$work" && bash scripts/update-ledger.sh "$@" 2>&1 ); }
status() { ( cd "$work" && bash scripts/update-ledger.sh "$@" >/dev/null 2>&1; echo $? ); }

echo "==> update-ledger refusals"

# 1. The readiness ledger, whose rule this script cannot meet.
out="$(run P0.1 t-ac1)"
if [[ "$(status P0.1 t-ac1)" != "2" ]]; then bad "readiness row must be REFUSED"; else
  case "$out" in
    *"states its own rule"*|*"independent verifier"*|*"INDEPENDENT VERIFIER"*) ok "readiness ledger refused" ;;
    *) bad "refusal must say WHY: $out" ;;
  esac
fi
if grep -q -- '- \[x\] P0.1' "$work/specs/readiness-recovery-10-10/tasks.md"; then
  bad "the readiness row was flipped anyway"
else
  ok "the readiness row is untouched"
fi

# 2. An id present in two ledgers. Silently closing both is how a row ends up done with nobody
#    deciding it should be.
if [[ "$(status SHARED t-ac1)" != "2" ]]; then bad "an ambiguous id must be REFUSED"; else
  ok "ambiguous id refused"
fi
if grep -q -- '- \[x\] SHARED' "$work/specs/alpha/tasks.md" || grep -q -- '- \[x\] SHARED' "$work/specs/beta/tasks.md"; then
  bad "an ambiguous id flipped a row"
else
  ok "neither ambiguous row was flipped"
fi

# 3. An id that matches nothing. Previously a silent success that reported "Ledger updated".
if [[ "$(status NOSUCHTASK t-ac1)" != "2" ]]; then bad "an unknown id must be REFUSED"; else
  ok "unknown id refused"
fi

# 4. Shell/sed metacharacters, the pre-existing guard. Kept so a rewrite cannot drop it.
if [[ "$(status 'T1;rm' t-ac1)" != "2" ]]; then bad "a metacharacter id must be REFUSED"; else
  ok "metacharacter id refused"
fi

# 5. THE CONTROL. An ordinary row in an ordinary ledger still closes — without it, every assertion
#    above is satisfied by a script that refuses everything and the tool would be useless.
echo "==> update-ledger still closes an ordinary row"
if [[ "$(status T1 t-ac1)" != "0" ]]; then
  bad "an ordinary row was refused"
else
  if grep -q -- '- \[x\] T1' "$work/specs/alpha/tasks.md"; then ok "T1 closed in specs/alpha"; else bad "T1 not flipped"; fi
  # And ONLY that ledger.
  if grep -q -- '- \[x\]' "$work/specs/beta/tasks.md"; then bad "closing T1 also touched specs/beta"; else ok "specs/beta untouched"; fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "update-ledger guard test FAILED" >&2
  exit 1
fi
echo "update-ledger guard test OK"

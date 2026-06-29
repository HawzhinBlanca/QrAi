#!/usr/bin/env bash
# Reads Claude Code hook JSON on stdin. Exit 2 blocks the tool call.
#
# Hardened beyond the blueprint's reference patterns (which an independent review found
# bypassable): protected-path globs also match RELATIVE paths, and the dangerous-command
# regex covers flag reordering, wget/fetch (not just curl), force-push via +ref and
# --force-with-lease, and git commit/push --no-verify (a CODYSTEM anti-cheat boundary).
set -euo pipefail
input="$(cat)"
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Protected paths (Edit/Write/MultiEdit). Each protected dir has both an absolute
# (`*/dir/*`) and a relative (`dir/*`) form so `dist/app.js` is blocked as well as
# `/abs/path/dist/app.js`. `*.env` / `*.env.*` / `*.pem` already match relative + absolute.
if [[ -n "$path" ]]; then
  case "$path" in
    *.env|*.env.*|*.pem \
    |*/secrets/*|secrets/* \
    |*/node_modules/*|node_modules/* \
    |*/dist/*|dist/* \
    |*/build/*|build/* \
    |*/target/*|target/* \
    |*/out/*|out/* \
    |*/legacy/*|legacy/*)
      echo "BLOCKED: $path is a protected path (AGENTS.md hard boundary)." >&2
      exit 2 ;;
  esac
fi

# Dangerous shell commands (Bash). Any match -> deny.
if [[ -n "$cmd" ]]; then
  # Recursive-force rm, detected as recursive AND force INDEPENDENTLY so split flags
  # (`rm -r -f`, `rm -f -r`, `rm -r --force`, `rm --recursive --force`) cannot bypass it
  # the way a single-token-only regex (`-rf`) would. Flag tokens must start with `-`
  # (a leading-dash boundary), so filenames like `my-archive` don't false-positive.
  if printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|[[:space:]])rm([[:space:]]|$)'; then
    rec=0; frc=0
    printf '%s' "$cmd" | grep -Eq '[[:space:]]-[A-Za-z]*r[A-Za-z]*([[:space:]]|$)|[[:space:]]--recursive([[:space:]=]|$)' && rec=1
    printf '%s' "$cmd" | grep -Eq '[[:space:]]-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)|[[:space:]]--force([[:space:]=]|$)' && frc=1
    if [[ "$rec" -eq 1 && "$frc" -eq 1 ]]; then
      echo "BLOCKED: recursive-force rm detected (AGENTS.md hard boundary)." >&2
      exit 2
    fi
  fi
  # Other dangerous patterns -> deny.
  if printf '%s' "$cmd" | grep -Eq \
      -e 'git[[:space:]]+push[[:space:]].*(--force|--force-with-lease)' \
      -e 'git[[:space:]]+push[[:space:]].*[[:space:]]\+' \
      -e 'git[[:space:]]+reset[[:space:]]+--hard' \
      -e 'git[[:space:]]+(commit|push)[[:space:]].*--no-verify' \
      -e '(curl|wget|fetch)[[:space:]].*\|[[:space:]]*(sh|bash|zsh)' ; then
    echo "BLOCKED: dangerous command pattern detected." >&2
    exit 2
  fi
fi
exit 0

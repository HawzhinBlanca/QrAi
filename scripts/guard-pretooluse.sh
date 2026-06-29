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
  if printf '%s' "$cmd" | grep -Eq \
      -e 'rm[[:space:]]+-[a-zA-Z]*([rR][a-zA-Z]*[fF]|[fF][a-zA-Z]*[rR])' \
      -e 'rm[[:space:]].*--recursive.*--force' \
      -e 'rm[[:space:]].*--force.*--recursive' \
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

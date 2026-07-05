#!/usr/bin/env bash
# Generate strong production secrets and write them to a gitignored env file (default: .env.production).
#
# platform-api and the realtime gateway REFUSE to boot on missing / known-default / <32-char secrets
# (ensure_secure_config), so provisioning has to produce strong, non-default values. This makes that a
# single command. The output is gitignored (.gitignore ignores .env.*) — keep it out of version control
# and inject it at deploy time (e.g. `docker compose --env-file <file> up -d`, or your secret manager).
#
# Usage:  bash scripts/gen-production-secrets.sh [output-file]
set -euo pipefail

OUT="${1:-.env.production}"

if [[ -e "$OUT" ]]; then
  echo "Refusing to overwrite existing '$OUT'. Delete it first if you really intend to rotate." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets but was not found on PATH." >&2
  exit 1
fi

# 48 alphanumeric chars (well over the 32-char minimum). `cut` (not `head -c`) reads the whole stream,
# so openssl never gets SIGPIPE under `set -o pipefail`.
gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-48; }

JWT_SECRET="$(gen)"
TICKET_SECRET="$(gen)"
ML_API_KEY="$(gen)"
ASR_API_KEY="$(gen)"
PG_PASSWORD="$(gen)"

umask 077
cat > "$OUT" <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/gen-production-secrets.sh — DO NOT COMMIT.
# Strong, non-default values that satisfy the platform-api/gateway boot-time secret checks.
POSTGRES_PASSWORD=$PG_PASSWORD
JWT_SECRET=$JWT_SECRET
REALTIME_GATEWAY_TICKET_SECRET=$TICKET_SECRET
ML_API_KEY=$ML_API_KEY
ASR_API_KEY=$ASR_API_KEY
# Production posture: real auth, no insecure fallbacks.
ALLOW_INSECURE_DEFAULTS=0
EOF
chmod 600 "$OUT"

echo "Wrote '$OUT' (mode 600, gitignored)."
echo "Deploy with:  docker compose --env-file '$OUT' up -d"
echo "Rotate by deleting the file and re-running this script (then restart the stack)."

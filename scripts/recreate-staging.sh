#!/usr/bin/env bash
# Automates Phase 0 Task 0.4: Establish a disposable staging environment.
# Recreates the staging stack from zero, rotates secrets, boots the containers,
# and verifies they pass health checks.
set -euo pipefail

PROJECT_NAME="quran-ai-staging"
ENV_FILE=".env.staging"
MAX_WAIT_SECS=30

echo "=== 1. Destroying old staging stack if it exists ==="
if [ -f "$ENV_FILE" ]; then
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" down -v --remove-orphans || true
  rm -f "$ENV_FILE"
else
  # Fallback down if no env file exists (using dummy env to pass compose validation)
  POSTGRES_PASSWORD=dummy JWT_SECRET=dummy REALTIME_GATEWAY_TICKET_SECRET=dummy ML_API_KEY=dummy ASR_API_KEY=dummy \
    docker compose -p "$PROJECT_NAME" down -v --remove-orphans || true
fi

echo "=== 2. Generating fresh secrets for staging ==="
bash scripts/gen-production-secrets.sh "$ENV_FILE"

# Add staging overrides to .env.staging
echo "# Staging operational flags" >> "$ENV_FILE"
echo "ALLOW_INSECURE_DEFAULTS=0" >> "$ENV_FILE"

echo "=== 3. Pulling/Building staging images ==="
docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" build

echo "=== 4. Starting staging environment ==="
docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" up -d

echo "=== 5. Waiting for services to become healthy ==="
wait_for_health() {
  local service="$1"
  local url="$2"
  echo -n "Waiting for $service to be ready..."
  for ((i=1; i<=MAX_WAIT_SECS; i++)); do
    # Try fetching HTTP status code
    if status_code=$(curl -s -o /dev/null -w "%{http_code}" "$url"); then
      if [ "$status_code" = "200" ]; then
        echo " OK (HTTP 200)"
        return 0
      fi
    fi
    echo -n "."
    sleep 1
  done
  echo " FAILED (timeout)"
  return 1
}

# The platform-api readiness check verifies database connection
# (localhost:8080/ready is mapped from container port 8080)
wait_for_health "platform-api" "http://localhost:8080/ready" || {
  echo "ERROR: platform-api failed to boot healthy. Logs:"
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" logs platform-api
  exit 1
}

wait_for_health "realtime-gateway" "http://localhost:8081/health" || {
  echo "ERROR: realtime-gateway failed to boot healthy. Logs:"
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" logs realtime-gateway
  exit 1
}

wait_for_health "web" "http://localhost:5173/" || {
  echo "ERROR: web static server failed to boot healthy. Logs:"
  docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" logs web
  exit 1
}

echo "=== SUCCESS: Disposable staging environment successfully recreated and verified healthy ==="
docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" ps

#!/bin/sh
set -eu

case "${WEB_PLATFORM_API_UPSTREAM:-}" in
  platform-api:8080|node-api:8082)
    ;;
  *)
    echo "WEB_PLATFORM_API_UPSTREAM must be platform-api:8080 or node-api:8082" >&2
    exit 1
    ;;
esac

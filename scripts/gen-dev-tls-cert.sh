#!/usr/bin/env bash
# Generate a self-signed TLS cert for the LOCAL TLS stack (T12).
#
# Why this exists: getUserMedia is disabled on insecure origins, so the pilot literally cannot
# record over plain HTTP off-host. Running the stack over TLS locally is the only way to exercise
# the real recording path before deploying.
#
# mkcert would produce a cert the browser trusts with no warning, but it is NOT installed here
# (`brew install mkcert`). openssl is, so this makes a self-signed CA + leaf. The browser will warn
# once; accept it, or install mkcert and re-run for a warning-free cert.
#
#   bash scripts/gen-dev-tls-cert.sh            # -> infra/tls/{cert,key}.pem
#
# Output is *.pem, which .gitignore already excludes and verify.sh's guard refuses to let anyone
# track. These are DEV certs: never deploy them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
OUT="${ROOT}/infra/tls"
mkdir -p "$OUT"

if command -v mkcert >/dev/null 2>&1; then
  echo "==> mkcert found — issuing a locally-trusted cert (no browser warning)"
  mkcert -install
  mkcert -cert-file "${OUT}/cert.pem" -key-file "${OUT}/key.pem" localhost 127.0.0.1 ::1
else
  echo "==> mkcert not installed; falling back to an openssl self-signed cert"
  echo "    (the browser will warn once — accept it, or 'brew install mkcert' and re-run)"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${OUT}/key.pem" -out "${OUT}/cert.pem" \
    -days 365 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
fi

# nginx runs as UID 101 (nginx-unprivileged) and must be able to read the key.
chmod 644 "${OUT}/cert.pem"
chmod 644 "${OUT}/key.pem"

echo "==> wrote ${OUT}/cert.pem and ${OUT}/key.pem"
openssl x509 -in "${OUT}/cert.pem" -noout -subject -dates -ext subjectAltName
echo
echo "Next:"
echo "  docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build web"
echo "  open https://localhost/    (http://localhost/ 301s to it)"

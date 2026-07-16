# Runbook: Staging Environment Management

This document describes how to deploy, manage, and recreate the staging environment for the **Quran Recitation Intelligence OS** (`quran-ai-platform`).

## Objectives
* Prove production-like environment readiness (e.g. running non-root, enforcing TLS/HSTS, using restricted database role).
* Ensure environment disposability (destroy/recreate from zero succeeds).
* Restrict security boundaries (zero default/committed credentials, no `ALLOW_INSECURE_DEFAULTS` enabled).

---

## 1. Automated Lifecycle Management

The script [recreate-staging.sh](file:///Users/hawzhin/QrAi/scripts/recreate-staging.sh) implements the complete staging lifecycle:
1. Shuts down and purges any existing staging container stack and named volumes.
2. Removes old env settings.
3. Invokes the secure key generator to write new random secrets to a gitignored `.env.staging` file.
4. Builds/pulls container images.
5. Starts the isolated `quran-ai-staging` Compose stack.
6. Polls health checkpoints for the Platform API, Realtime Gateway, and Web Server.

### Execution
Run the lifecycle manager from the repository root:
```bash
bash scripts/recreate-staging.sh
```

---

## 2. Manual Commands Reference

### Destroying Staging
To cleanly dismantle the staging environment and discard all temporary volumes (like DB state and user recordings):
```bash
docker compose -p quran-ai-staging --env-file .env.staging down -v --remove-orphans
```

### Checking Status & Logs
```bash
# List containers and health status
docker compose -p quran-ai-staging --env-file .env.staging ps

# Follow logs from platform api
docker compose -p quran-ai-staging --env-file .env.staging logs -f platform-api
```

### Rotating Secrets
Secrets must never be reused across stages or deployments. To rotate all staging keys:
1. Shut down the current deployment:
   ```bash
   docker compose -p quran-ai-staging --env-file .env.staging down
   ```
2. Remove the old environment file:
   ```bash
   rm -f .env.staging
   ```
3. Run the recreation script again to generate new secure keys and restart the containers:
   ```bash
   bash scripts/recreate-staging.sh
   ```

## 3. TLS stack (T12)

**Why it matters:** `getUserMedia` is disabled on insecure origins. Served over plain HTTP to
anything but `localhost`, the app **cannot open the microphone** — so a recitation pilot on
classroom laptops is impossible without TLS. This is a functional requirement, not hardening.

`docker-compose.tls.yml` is an **opt-in overlay** (deliberately not `docker-compose.override.yml`,
which compose auto-loads — the TLS stack needs certs to exist first).

```bash
bash scripts/gen-dev-tls-cert.sh          # -> infra/tls/{cert,key}.pem (gitignored; dev only)
docker compose -p quran-ai-staging --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

`https://localhost/` — `http://localhost/` 301s to it. `mkcert` gives a warning-free cert if
installed; otherwise the script falls back to openssl self-signed (accept the warning once).

**What changes vs the plain stack**

| | plain | TLS overlay |
|---|---|---|
| web | `5173` → HTTP | `80` (301 →) + `443` |
| API | published `8080`, app calls it directly | proxied at `/v1/` on the **same origin**; loopback-only |
| gateway | published `8081`, `ws://` | proxied at `/ws/` as **`wss://`**; loopback-only |
| CSP `connect-src` | `'self' ws: wss:` | `'self'` (everything is same-origin now) |
| HSTS | — | `max-age=31536000; includeSubDomains` |

**Three things that are easy to get wrong (all verified against the running stack):**

1. **`VITE_*` are BUILD args, not runtime env.** Vite inlines them at build time; the web image is
   static files served by nginx, so anything under `environment:` is inert. They now live in
   `build.args` — which is why the TLS stack needs `--build`, not just `up`.
2. **The gateway needs `CORS_ALLOWED_ORIGINS`.** Its CSWSH defence **fails closed**: unset, it
   rejects *every* WebSocket (`CORS_ALLOWED_ORIGINS unset in production`). The overlay sets
   `https://localhost`.
3. **`TRUST_PROXY_HEADERS=1` is mandatory behind nginx**, or the gateway's per-IP rate limiter keys
   on nginx's address and collapses every learner into one shared bucket. Safe only because the
   overlay stops publishing `8081` — otherwise a client could hand it a spoofed `X-Real-IP`.

**Verifying it:**
```bash
curl -s -o /dev/null -D - http://localhost/          # 301 -> https, path preserved
curl -sk -o /dev/null -D - https://localhost/        # HSTS + security headers + CSP
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/v1/quran/surahs   # 200 via nginx
# wss:// upgrade must be HTTP/1.1 — over HTTP/2 it needs Extended CONNECT and 400s:
curl -sk --http1.1 -o /dev/null -w '%{http_code}\n' \
  -H 'Origin: https://localhost' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://localhost/ws/v1/recitation-sessions/s1/audio'   # 401 = routed + ticket auth ran
```
A **404** on that last one means `/ws/` was forwarded to the gateway instead of stripped — the
`proxy_pass` trailing slash is load-bearing.

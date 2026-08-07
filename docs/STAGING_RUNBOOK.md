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

## Kill-switch — graceful maintenance mode (P5.5)

To take the pilot down **gracefully** (better than `docker compose stop`, which fails healthchecks
and reads as a crash): put `platform-api` in maintenance mode. Every route except `/health`,
`/ready`, `/metrics` then returns a clean `503 {"error":"service is in maintenance"}`, so
orchestrator healthchecks and monitoring keep seeing the process as up-in-maintenance.

**Engage:**
```bash
MAINTENANCE_MODE=1 docker compose up -d platform-api      # ~seconds; other services untouched
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/v1/quran/surahs   # 503
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/health            # 200 (still live)
```

**Restore (rollback):**
```bash
MAINTENANCE_MODE=0 docker compose up -d platform-api      # or unset it and re-up
```

Flipping requires the env change + a container restart (read once at startup). If ops ever need a
no-restart live toggle, upgrade `maintenance_mode` to an `Arc<AtomicBool>` flipped by an
admin-only endpoint (see the note on `AppState.maintenance_mode` in `services/platform-api/src/lib.rs`).

---

## Incident response: take down, roll back, restore, bring up

Added by P4-T5 (`specs/dr-rehearsal/plan.md`). `monitoring/alerts.yml` routes `PlatformApiDown` here
with "consider kill-switch + rollback", so this section closes a reference that previously pointed at
a document explaining neither.

> **Read this first.** Timings below are marked UNMEASURED where no drill has produced a number.
> They are deliberately not estimates. A number here that nobody measured is worse than no number,
> because it will be planned against. See `specs/dr-rehearsal/evidence/`.

### 1. Take the service down gracefully (kill-switch)

Prefer this to stopping containers: `/health`, `/ready` and `/metrics` stay live, so the outage reads
as "up, in maintenance" rather than "crashed", and monitoring keeps working while you work.

```bash
MAINTENANCE_MODE=1 docker compose up -d platform-api
# verify: app routes 503, health/ready/metrics still 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/recitation-sessions   # expect 503
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/health                    # expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/ready                     # expect 200
```

Enforced by the middleware layer inside CORS (`platform-api/src/lib.rs:344`), so 503s still carry
CORS headers and a browser client sees a clean error rather than a network failure.

**MEASURED (T3 drill, 2026-07-30):** with `MAINTENANCE_MODE=1`, `/v1/recitation-sessions`,
`/v1/learners/active` and `/v1/tajweed-findings` all returned **503** while `/health`, `/ready`
and `/metrics` returned **200**. Control run with `MAINTENANCE_MODE=0` on the same binary and
database returned **200** on those app routes, so the 503s are the switch and not an unrelated
failure. Process start to serving traffic: **1s**. Evidence:
`specs/dr-rehearsal/evidence/T3-killswitch-drill.log`.

> The switch is read once at startup, so it takes effect on restart — it is not a live toggle.

To bring it back: `MAINTENANCE_MODE=0 docker compose up -d platform-api`.

### 2. Roll back

> ⚠️ **There is currently nothing to roll back to.** Every app service is built from source
> (`build:`), and no image artifact is produced anywhere. "Rollback" today means
> `git checkout <sha> && docker compose build` — a rebuild, which takes minutes and **can fail for
> reasons unrelated to the code you are restoring**. That is not theoretical: the postcss advisory
> (#261) red-lighted every branch including `main` at a commit that had passed CI hours earlier.
>
> **ADR-0022** proposes the fix (digest-pinned images with tag retention). Until it lands, treat
> rollback as a rebuild and budget minutes, not seconds — and prefer the kill-switch (step 1) plus
> restore (step 3) as your fast path.

Interim procedure (rebuild-based):

```bash
MAINTENANCE_MODE=1 docker compose up -d platform-api   # stop the bleeding first
git checkout <last-known-good-sha>
docker compose build platform-api realtime-gateway     # these two move TOGETHER — the realtime
                                                        # ticket is a cross-service HMAC contract
docker compose up -d platform-api realtime-gateway
MAINTENANCE_MODE=0 docker compose up -d platform-api
```

**Time: UNMEASURED, and dependent on build success.**

### 3. Restore the database

```bash
# Backups: scripts/backup-db.sh (custom-format pg_dump, encrypted, rotated). Restore into a FRESH database.
# BACKUP_DECRYPTION_KEY is the OFFLINE private key — retrieving it is a rehearsed step of the drill.
RESTORE_TARGET_URL="postgresql://<user>:<pass>@<host>:5432/quran_ai_restored" \
RESTORE_APP_DATABASE_PASSWORD="<strong-runtime-password>" \
BACKUP_DECRYPTION_KEY=/path/to/qrai-backup-private.key \
  bash scripts/restore-db.sh backups/quran_ai-<timestamp>.dump.cms
```

`restore-db.sh` refuses a non-empty target unless `RESTORE_FORCE=1`, and has **no default target** —
`verify.sh` exports a default `DATABASE_URL` pointing at a real database, so a fallback would let a
drill overwrite live data. It verifies row counts after restoring and fails loudly rather than
reporting a partial restore as success. The target URL must be administrative: restore then applies
the immutable migration ledger and rotates the restricted application role before verification.

**MEASURED (T1 drill, 2026-07-30): restore of the full corpus completed in <1s** (1-second timer
resolution) from a 4.9 MB custom-format dump, with all row counts matching the source exactly
(114 surahs / 6,236 ayahs / 82,456 words / 5 users / 1 consent record / 1 session). The drill also
proved the verification has teeth: restoring a deliberately under-seeded dump reported
`FAIL canonical_ayahs expected 6236, got 7` and exited 1. Evidence:
`specs/dr-rehearsal/evidence/T1-restore-drill.log`.

### Repair retained audio that was stored but not indexed

Alert on either a zero `realtime_gateway_audio_index_enabled` gauge or an increase in
`realtime_gateway_chunks_stored_unindexed_total`. First fix the gateway configuration—the Compose
service now sets `PLATFORM_API_URL=http://platform-api:8080`—then preview reconciliation:

```bash
docker compose --profile operations run --rm \
  audio-index-repair node server/scripts/repair-audio-index.mjs
```

Review the JSON counts and every refusal. Apply only after the preview is understood:

```bash
docker compose --profile operations run --rm audio-index-repair
```

The operation mounts `audio_storage` read-only and uses the restricted `quran_ai_app` database role.
A sidecar does not grant ownership: its tenant/learner path, metadata, bytes, object key, span, and
the tenant-scoped session's actual learner must agree. Mismatches remain unindexed, are reported in
`errors`, and make the CLI exit nonzero. Re-running a successful repair is idempotent.

> **This number is a FLOOR, not a prediction.** Isolated infrastructure, no network latency, no
> concurrent load, and a 6,236-ayah corpus is not a year of pilot audio.
>
> **The measurement above also predates encryption.** Backups are now encrypted CMS envelopes
> (ADR-0035), so a restore adds a decryption step and the drill must be re-timed — the number will
> move, and re-measuring it is part of the P5.6 drill rather than something to estimate here.

> 🔴 **Legal step, not optional.** If the dump predates a learner's right-to-erasure request, the
> restore **resurrects data they asked to have deleted**. Re-apply outstanding erasure requests
> immediately after restoring, before the database serves traffic. Audio blobs live in the
> `audio_storage` volume, outside the dump, and must be handled separately.

### 4. Bring the service back

```bash
MAINTENANCE_MODE=0 docker compose up -d platform-api
bash scripts/smoke-api.mjs      # or: pnpm smoke:all
```

Confirm in Grafana that `http_requests_total` is climbing and no alert from `monitoring/alerts.yml`
is still firing before declaring the incident closed.

### What is NOT proven here

**Proven by drill (2026-07-30):** database restore (T1) and the kill-switch (T3) — both on isolated
infrastructure, both with controls, evidence in `specs/dr-rehearsal/evidence/`.

**NOT proven:**
- **Rollback (step 2).** There is still no artifact to roll back to — see ADR-0022. What is written
  above is a rebuild procedure, and it is untimed.
- **Audio-volume recovery.** The `audio_storage` volume has no tested restore path (T2 not run).
- **Anything at production scale.** Every measurement here is a floor from an isolated drill.
- **P5.5, P5.6, P5.7, P7.5 all remain open.** P5.6 additionally requires encrypted backups.

Do not cite this runbook as proof that recovery works end to end. Cite it for the two things that
were measured, and treat the rest as procedure awaiting rehearsal.

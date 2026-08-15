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

Before promoting Node HTTP traffic, confirm its startup log contains no database-role refusal and
that `/ready` is 200 while connected with the provisioned runtime URL. `node-api` now refuses to
listen when the effective role is `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, or
`REPLICATION`; do not set `ALLOW_SUPERUSER_DB_ROLE` to make staging green. Correct `DATABASE_URL`
to the provisioned restricted login. Keep the administrative migration URL confined to the
migration/provision operation.

All Node dependency calls use `UPSTREAM_TIMEOUT_SECS` (default 60, strict positive whole seconds).
The API consumes one request budget across Postgres, compatibility, worker/ASR, privacy, and review
audio; the worker inference runtime consumes the same setting across every
ASR/forced-alignment/acoustic window.
Do not raise it to hide a hanging dependency. A timeout is expected to return fixed 502/503, include
`Retry-After: 1` for database/worker 503s, close the downstream socket, and leave no transaction or
delete/playback completion claim. Diagnose the named dependency through internal metrics/traces,
not by enabling detailed public errors. Before promotion, run the live form of
`tests/faults/dependency-timeouts.test.mjs` against the provisioned restricted URL.

Node API termination uses `SHUTDOWN_GRACE_SECS` (strict whole seconds, 1–300; Compose default 8).
Keep the orchestrator stop window larger; Compose defaults `NODE_API_STOP_GRACE_PERIOD` to `10s`.
Do not set equal values: the outer runtime needs time to observe the app exit before SIGKILL.
On SIGTERM, new work is refused immediately, completing HTTP work drains, remaining sockets close
at 80% of the budget, and the final 20% is reserved for the Postgres pool. A normal deploy logs, in
order, `shutdown started`, `resources closed`, and `shutdown complete`. `force-closing` means work or
an upgraded socket exceeded the drain phase; `hard deadline exceeded` is a failed deployment and
must alert. Validate the exact child/pool behavior with:

```bash
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test tests/node-api/graceful-shutdown.test.mjs
```

### Durable job worker and dead-letter recovery

`job-worker` is the same non-root `server` image with a different command, no host port, the
restricted application database URL, and the same private audio store. Its operation deadline must
be shorter than its lease (`JOB_OPERATION_TIMEOUT_SECS=60`, `JOB_LEASE_SECS=65` by default), and
`JOB_WORKER_STOP_GRACE_PERIOD` must exceed `JOB_WORKER_SHUTDOWN_GRACE_SECS`. Never point it at the
migration/admin URL. Confirm private readiness and scrape metrics from inside the container network:

```bash
docker compose ps job-worker
docker compose exec job-worker node server/src/container-healthcheck.mjs
docker compose exec -e PROBE_TOKEN="$METRICS_TOKEN" job-worker node -e \
  'fetch("http://127.0.0.1:8098/metrics",{headers:{"x-metrics-token":process.env.PROBE_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())})'
```

`node-realtime` is the third command of that image. Through W3.7 it remains internal: it publishes
no host port and receives no Web/gateway traffic. It admits only the exact session-audio shadow
route after ticket, tenant, lifetime, Origin/native, bounded peer-rate, and durable Postgres replay
checks, then applies the fixed 2 MiB application/2 MiB + 64 KiB transport limit, 8-chunk/4 MiB
per-session, 64 MiB process, and 100-session ceilings. A consumed, unknown, or database-expired claim is
bodyless 401; a replay-database timeout/outage is bodyless 503 and never upgrades. Its deep
readiness checks the restricted database role, private object
store, job worker, and loaded-model ASR within one bound. Supply a strong
`REALTIME_GATEWAY_TICKET_SECRET`, exact `GATEWAY_TENANT_ID`, and canonical comma-separated
`CORS_ALLOWED_ORIGINS`; enable missing-Origin or proxy trust only through their explicit bounded
switches. Confirm readiness and private metrics without routing traffic:

```bash
docker compose ps node-realtime
docker compose exec node-realtime node server/src/container-healthcheck.mjs
docker compose exec -e PROBE_TOKEN="$METRICS_TOKEN" node-realtime node -e \
  'fetch("http://127.0.0.1:8081/metrics",{headers:{"x-metrics-token":process.env.PROBE_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())})'
```

Confirm migrations 0036 through 0038 are applied before boot. Investigate any growth in fixed
`replay_unavailable` admission outcomes or failed replay-cleanup runs; the process deliberately has
no memory fallback. Never delete live replay rows to repair admission. Resolve database
availability/locks, then let bounded cleanup remove only database-expired rows. Session/privacy
deletion cascades its own replay rows. No raw ticket, nonce, learner, session, or tenant should
appear in logs or metric labels.

Alert on sustained `backpressure`, `slow_consumer`, `failed`, or `aborted` audio outcomes and on
retained gauges that do not return to zero after peers close. `accepted=true` means enqueued, not
stored or indexed. For the W3.6 delivery counter, `stored_unindexed`,
`stored_unindexed_unrecorded`, `accepted_lost`, or `accepted_lost_unrecorded` requires investigation;
the two unrecorded outcomes mean Postgres could not preserve the diagnostic. Stop the shadow, fix
the dependency, then use the dry-run repair procedure below for verified retained objects. Do not
delete or hand-edit outcome rows. Do not route traffic to this shadow until the W3.7 contract is
implemented in Flutter, browser/native codec and rate decisions are frozen, and production-image,
canary, and rollback gates pass.

Migration 0038 adds an optional immutable client-capture summary to the owning session. Only the
owning learner may submit or retry that summary; staff finalization must use the legacy empty body.
Treat `recordingStatus=incomplete` or `unverified` as learner-visible integrity truth, not as a failed
alignment job and not as a Prometheus label. Client dropped/uncertain counts and server lost counts
are separate sources and must never be summed or deduplicated by operators. Never rewrite a
committed report to make a session complete. The manual chaos command requires an existing test
session, obtains every ticket from the API, finalizes with exact accounting, and fails degraded by
default; it is candidate evidence only when run against the approved environment.

`NodeRealtimeShadowUnready` is an investigation warning during this no-traffic phase. Diagnose the
four closed readiness classes; never expose upstream errors or attach identity labels. W3.9, not
this shadow, owns traffic movement.

Confirm that the deployment has one Node artifact rather than three drifting service images:

```bash
test "$(docker compose images --quiet node-api job-worker node-realtime | sort -u | wc -l | tr -d ' ')" = 1
! docker compose config --services | grep -qx ml-inference
node scripts/smoke-ml.mjs
node scripts/smoke-privacy.mjs
```

The first command requires all three Node roles to resolve to the same image id. The second
proves the retired standalone ML service did not return through an overlay. The smokes exercise the
worker's private compatibility and shared storage/privacy paths; they are operational checks, not
model-quality or public-traffic-cutover evidence.

Alert on any non-zero `job_state{status="dead"}`, sustained retry growth, or a queued/running backlog
that does not drain. Metrics intentionally contain only state, kind, and outcome—not tenant,
learner, session, job, trace, or object-key labels. A worker start/ready failure is investigated via
database role, migration state, inference/ASR readiness, and storage readiness; do not enable detailed public
errors or a privileged DB role.

For rollback to the Rust compatibility path, stop `job-worker` first and wait for its graceful exit.
Queued rows are recoverable and must remain untouched while Node effects are paused. For a dead
letter, stop the worker while diagnosing, then inspect only bounded operational columns under the
restricted tenant context:

```bash
docker compose stop job-worker
psql "$RESTRICTED_URL" -X -v ON_ERROR_STOP=1 -v tenant="$TENANT_ID" <<'SQL'
begin;
select set_config('app.tenant_id', :'tenant', true);
select id, kind, attempt_count, max_attempts, last_error_code, dead_at
  from background_jobs
 where tenant_id = :'tenant' and status = 'dead'
 order by dead_at desc, id
 limit 50;
commit;
SQL
```

Fix the fixed-code root cause before replay. Do not `UPDATE` the dead row, reset attempts, alter a
lease generation, copy payload JSON by hand, or delete its audit. Replay with the internal command;
it refuses privileged database roles and any operator who is not an in-tenant admin/ops user, emits
only source/new job identifiers, and creates one audited successor while preserving the dead row:

```bash
docker compose run --rm --no-deps job-worker \
  node server/scripts/requeue-dead-job.mjs \
    --tenant-id "$TENANT_ID" --job-id "$DEAD_JOB_ID" --operator-id "$OPERATOR_ID"
docker compose up -d job-worker
```

Repeating that command for the same dead row returns the same successor. If the successor exhausts
its attempts, diagnose and replay that new dead job; this preserves the complete fence/recovery
lineage. Privacy replay may repeat object deletion by design, but its original bounded manifest and
database receipt are committed once. There is no public job or replay endpoint.

### Controlled device enrollment rollout

Device identity is implemented but remains an owner-controlled production boundary. Compose passes
`DEVICE_IDENTITY_ENABLED=0` by default; do not set it to one merely to make a test or demo pass.
Record explicit owner approval, confirm migration 0035 and the restricted role grants are applied,
run the live W2.16 suite, and provision a bounded canary before enabling routes.

For an existing in-tenant user, run the audited command from the already-running stack:

```bash
docker compose run --rm --no-deps node-api \
  node server/scripts/provision-device-enrollment.mjs \
    --tenant-id "$TENANT_ID" --admin-id "$ADMIN_ID" --user-id "$USER_ID"
```

If the target does not exist, add all three approved fields: `--new-user-role` (only `learner`,
`teacher`, or `scholar`), `--new-user-display-name`, and `--new-user-language`. Existing targets
must not receive those flags. The command validates a stored in-tenant admin through the restricted
database role. It generates a 24-hour invitation internally and prints its raw value exactly once
in the success JSON. Treat stdout as a secret: capture it only in the approved credential channel,
do not copy it into tickets/chat/logs, and do not put a token in command arguments. The database and
audit event contain only its SHA-256 hash and identifiers.

After provisioning and live proof, enable the bounded Node canary and recreate only that service:

```bash
DEVICE_IDENTITY_ENABLED=1 docker compose up -d --no-deps node-api
docker compose exec node-api node server/src/container-healthcheck.mjs
```

Keep Web login off. Only the three device routes change registration; Rust/Web traffic routing and
password/pilot compatibility are unchanged. Observe enrollment/refusal audit events and ordinary
bounded HTTP status metrics—never credentials. A refresh replay returns generic 401 only after the
entire credential family is revoked and audited. Treat that as credential compromise: remove the
client credential, investigate the device, and issue a new invitation through the same admin
command. Never reactivate or rewrite an old generation.

Rollback is safe and does not delete identity evidence:

```bash
DEVICE_IDENTITY_ENABLED=0 docker compose up -d --no-deps node-api
```

The additive rows become inert while existing JWT/pilot flows remain unchanged. Do not drop
migration 0035 or delete rows during rollback. Re-enable only after the owner and incident owner
approve a new bounded canary.

The Node API has no WebSocket route. The separate Node realtime process owns only the exact
authenticated session-audio upgrade and now runs the bounded W3.6 storage/index shadow handler; it
also carries the W3.7 reference recovery contract and still has no host/public traffic edge. Its
shared raw-socket fallback bounds every unexpected upgrade.

## Kill-switch — graceful maintenance mode (P5.5)

To take the pilot down **gracefully** (better than `docker compose stop`, which fails healthchecks
and reads as a crash): put `platform-api` in maintenance mode. Every route except `/health`,
`/ready`, `/metrics` then returns a clean `503 {"error":"service is in maintenance"}`, so
orchestrator healthchecks and monitoring keep seeing the process as up-in-maintenance.

The W2.10 Node candidate consumes the same `MAINTENANCE_MODE` value and exact exemptions. During
the current compatibility observation phase, recreate both `platform-api` and `node-api` after a
switch change; after HTTP traffic cutover, `node-api` is the process that must be recreated. The
switch remains startup-read and is not a live admin endpoint.

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

Node HTTP admission is default-on with a 200 request burst and one token replenished every 50 ms.
`DISABLE_RATE_LIMIT=1` is for controlled development/parity only. Forwarded client IP headers are
ignored unless `TRUST_PROXY_HEADERS=1` (or `true`) is explicitly set; when enabled,
`TRUST_PROXY_HOPS` defaults to one and must be a whole number from 1 to 32. Enable it only behind a
proxy that overwrites forwarded headers—direct exposure would let a caller choose admission keys.

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

### 2. Immutable HTTP canary and reversal

Release deployment uses registry digests, never a source rebuild. The release workflow must first
publish all six deployable artifacts and provide strict candidate and previous digest documents.
Keep the selection and generated environment files outside the repository with owner-only
permissions. The previous release must be compatible with the current append-only schema and its
images must already be present on the deployment host before canary traffic begins.

Create and validate one preserved selection:

```bash
node scripts/release-deployment.mjs create \
  --candidate-sha <40-hex-sha> --candidate-digests <candidate-digests.json> \
  --previous-sha <40-hex-sha> --previous-digests <previous-digests.json> \
  --namespace <ghcr-owner> --output <secure-selection.json>
node scripts/release-deployment.mjs env \
  --selection <secure-selection.json> --slot candidate --output <secure-candidate.env>
docker compose --project-name quran-ai-staging --env-file <secure-candidate.env> \
  -f docker-compose.yml -f docker-compose.release.yml -f docker-compose.canary.yml config --quiet
```

Only after the required owner/security/operations approvals, start the candidate with those exact
three Compose files. This explicit canary points Web and gateway indexing at Node together; Rust
stays healthy for transition routes and reversal. Do not add a percentage split or dual writes.
After startup, bind evidence to the actual running content:

```bash
node scripts/release-deployment.mjs verify \
  --selection <secure-selection.json> --slot candidate \
  --project-name quran-ai-staging --evidence-output <candidate-running-images.json>
```

For the destructive candidate proof, use only a disposable CI database or an isolated staging
database whose learner fixtures may be created and privacy-deleted. The command refuses a dirty
checkout, a source SHA different from the selected candidate, a non-isolated environment class,
source builds, stale container configuration, or an existing output path. It uses JWT actors rather
than enabling development header authentication. It probes all 39 retained routes and four Rust
transition routes, hostile inputs, tenant/privacy/effect behavior, durable audio indexing, and the
real gateway. It then stops Rust, proves retained routes remain Node-local while all four transition
routes fail through the unavailable Rust boundary, and restores/rechecks Rust even on failure.
The result is write-once and expires after 24 hours; a failed run produces failure evidence, never a
passing replacement.

```bash
DATABASE_URL='<disposable restricted database URL>' \
JWT_SECRET='<the deployed candidate JWT secret>' \
REALTIME_GATEWAY_TICKET_SECRET='<the deployed candidate ticket secret>' \
node scripts/http-canary-image.mjs \
  --selection <secure-selection.json> \
  --project-name quran-ai-staging \
  --environment-class staging-isolated \
  --provider <staging-provider> \
  --actor-class release-operator \
  --acknowledge-disposable-database yes \
  --evidence-output <new-http-canary-image-evidence.json>
```

This command proves the selected image set only; it does not approve promotion. Keep the output
outside the repository and do not reuse the database for learners or production records.

Run all three immutable load profiles against the same candidate source, Node container image ID,
and rendered topology hash. Each invocation writes a new artifact; a failed threshold remains failed.
`JOB_WORKER_HTTP` must address the real candidate worker from the load-runner network, not a mock or
source-checkout process.

```bash
CANARY_LOAD_PROFILE=classroom CANARY_LOAD_EVIDENCE_PATH=<classroom.json> k6 run scripts/load-test.js
CANARY_LOAD_PROFILE=burst     CANARY_LOAD_EVIDENCE_PATH=<burst.json>     k6 run scripts/load-test.js
CANARY_LOAD_PROFILE=soak      CANARY_LOAD_EVIDENCE_PATH=<soak.json>      k6 run scripts/load-test.js
```

For each run, also provide `CANDIDATE_HTTP`, `JOB_WORKER_HTTP`, `CANARY_BEARER_TOKEN`,
`CANDIDATE_SOURCE_SHA`, `NODE_BACKEND_IMAGE_ID`, and `CANARY_TOPOLOGY_SHA256` in the protected
runner environment. Never place the bearer token in an evidence file or command transcript.

Generate one observation document mechanically from the Prometheus snapshot plus active privacy,
tenant-isolation, and learner-feedback probes. It must contain exactly `nodeReady`, `workerReady`,
`rustReady`, `httpErrorRate`, `httpP95Ms`, `fallbackShare`, `jobQueued`, `jobRetry`, `jobDead`,
`privacyFailures`, `tenantIsolationFailures`, `lostChunks`, and `feedbackLeaks`. Do not hand-author
zeros. The controller calculates stop signals from this closed document; it does not trust a caller
to label an observation healthy.

```bash
DATABASE_URL='<isolated staging application database URL>' \
JWT_SECRET='<deployed JWT secret>' \
node scripts/http-canary-controller.mjs \
  --selection <secure-selection.json> \
  --run-class observation \
  --candidate-evidence <new-http-canary-image-evidence.json> \
  --classroom-load-evidence <classroom.json> \
  --burst-load-evidence <burst.json> \
  --soak-load-evidence <soak.json> \
  --observation <machine-observation.json> \
  --project-name quran-ai-staging \
  --evidence-output <new-controller-evidence.json>
```

Use `--run-class deliberate-drill` only for the approved stop rehearsal and `--run-class incident`
only for a real stop event. A no-stop observation accepts only `observation`; a stop signal accepts
only `deliberate-drill` or `incident`. This distinction is part of the immutable controller artifact,
so a real incident cannot later be relabeled as the release rehearsal.

A healthy observation exits only as `awaiting-human-promotion`; it performs no deployment mutation
and grants no approval. Any stop signal first recreates Web and realtime gateway together on the
Rust target using cached candidate images, then deploys the seven cached previous application images
with `--pull never`. It never runs an old database image or rolls schema/data backward. Verification
waits at most 60 seconds for all seven containers, checks their exact previous digests, sends one
synthetic progress write, proves exactly one stored effect, and privacy-deletes the synthetic
learner. The controller artifact exposes all three offline-verifiable claims: `storedEffects: 1`,
`duplicateEffects: 0`, and `privacyCleanup: passed`. Rollback-complete exits nonzero so automation cannot mistake a rejected candidate for a
promotion pass. Output is owner-only and write-once; a failed operation remains failed evidence.

If the controller itself fails, keep traffic on Rust and escalate. An operator may inspect the
restored application identities without involving the database runner:

```bash
node scripts/release-deployment.mjs verify \
  --selection <secure-selection.json> --slot previous --scope application \
  --project-name quran-ai-staging --evidence-output <new-previous-applications.json>
```

The previous release's forward-schema compatibility and locally cached digests are canary-entry
prerequisites, not incident-time experiments. **Time: UNMEASURED.** W2.18 T5 must record the
deliberate stop, previous-digest deployment, effect proof, and measured duration.

### T5 signed release closure

Promotion evidence is external to the clean candidate checkout. A protected monitoring attestor
signs a `qrai-http-canary-observation/v1` payload covering at least 15 minutes after all three load
profiles and binding the candidate source, Node image ID, topology hash, Prometheus query-result
hash, active privacy/tenant/feedback probe-result hash, and the exact closed observation values.
A protected CI attestor independently signs the candidate's exact successful check inventory:
`ci/android`, `ci/node-min`, `ci/verify`, `docker-build/build`, and `release-image/publish`.

After the healthy observation and deliberate rollback drill exist, the release owner, security
reviewer, and SRE each sign a separate `qrai-http-canary-approval/v1` payload. Each payload binds
the candidate-image artifact, the three load artifacts, signed observation, healthy controller,
deliberate rollback controller, and signed remote-CI payload. Keys and approvals are role-bound,
independent, active, and expire within 24 hours. The repository contains public-key policy and
verification logic only; private keys and approval decisions never enter the checkout, and
automation does not create a human decision.

`bash scripts/verify.sh --release` requires the following external paths:

```text
RELEASE_HTTP_CANARY_CANDIDATE_EVIDENCE
RELEASE_HTTP_CANARY_CLASSROOM_LOAD_EVIDENCE
RELEASE_HTTP_CANARY_BURST_LOAD_EVIDENCE
RELEASE_HTTP_CANARY_SOAK_LOAD_EVIDENCE
RELEASE_HTTP_CANARY_OBSERVATION_EVIDENCE
RELEASE_HTTP_CANARY_HEALTHY_CONTROLLER_EVIDENCE
RELEASE_HTTP_CANARY_ROLLBACK_CONTROLLER_EVIDENCE
RELEASE_HTTP_CANARY_REMOTE_CI_EVIDENCE
RELEASE_HTTP_CANARY_OWNER_APPROVAL
RELEASE_HTTP_CANARY_SECURITY_APPROVAL
RELEASE_HTTP_CANARY_SRE_APPROVAL
RELEASE_HTTP_CANARY_TRUST_POLICY
RELEASE_HTTP_CANARY_CLOSURE_OUTPUT
```

It validates the full chain before touching the release database, reruns validation after the full
release gate, and writes `RELEASE_HTTP_CANARY_CLOSURE_OUTPUT` with create-only permissions only after
everything passes. The output status is `ready-for-manual-promotion`; the validator never changes
traffic. Missing, stale, altered, wrong-role, reused-key, failed-check, incident-only, or
privacy-incomplete evidence fails closed.

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

Alert on either a zero `realtime_gateway_audio_index_enabled` gauge, an increase in
`realtime_gateway_chunks_stored_unindexed_total`, or a degraded Node
`realtime_audio_delivery_total` outcome. First fix the failing writer/index dependency, then
preview reconciliation:

```bash
docker compose --profile operations run --rm \
  audio-index-repair node server/scripts/repair-audio-index.mjs
```

Review the JSON counts and every refusal. Apply only after the preview is understood:

```bash
docker compose --profile operations run --rm audio-index-repair
```

The operation uses the same explicit storage driver as the runtime and the restricted `quran_ai_app`
database role. Local Compose mounts `audio_storage` read-only; an S3 deployment instead supplies the
private bucket configuration and must not treat a local volume as authoritative. Set
`AUDIO_RECONCILE_TENANT_IDS` (or repeat `--tenant=<id>`) so inverse reconciliation can find database
rows whose object is missing even when that tenant has no remaining storage keys. Storage metadata
does not grant ownership: its tenant/learner/session path, metadata, bytes, object key, span, and the
tenant-scoped session's actual learner and current retention must agree. Apply creates the index and
closes durable repair provenance in one tenant transaction. Incomplete object/metadata pairs and
inverse database-only rows are reported and never guessed, repaired, or deleted. Re-running a successful
repair is idempotent.

> **This number is a FLOOR, not a prediction.** Isolated infrastructure, no network latency, no
> concurrent load, and a 6,236-ayah corpus is not a year of pilot audio.
>
> **The measurement above also predates encryption.** Backups are now encrypted CMS envelopes
> (ADR-0035), so a restore adds a decryption step and the drill must be re-timed — the number will
> move, and re-measuring it is part of the P5.6 drill rather than something to estimate here.

> 🔴 **Legal step, not optional.** If the dump predates a learner's right-to-erasure request, the
> restore **resurrects data they asked to have deleted**. Re-apply outstanding erasure requests
> immediately after restoring, before the database serves traffic. Audio blobs live in the private
> S3-compatible store (or local `audio_storage` adapter), outside the dump, and must be restored and
> re-erased separately.

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
- **Production object-storage recovery.** The application adapter and local encrypted volume tools
  exist, but no selected production S3-compatible provider has a rehearsed backup/restore/erasure
  drill (T2 not run).
- **Anything at production scale.** Every measurement here is a floor from an isolated drill.
- **P5.5, P5.6, P5.7, P7.5 all remain open.** P5.6 additionally requires encrypted backups.

Do not cite this runbook as proof that recovery works end to end. Cite it for the two things that
were measured, and treat the rest as procedure awaiting rehearsal.

# W3.2 research — isolated Node realtime process lifecycle

**Status:** research complete; implementation not started<br>
**Method:** Serena is unavailable in this session, so definitions and references were mapped with
read-only `rg` and exact source inspection.<br>
**Scope:** W3.2 / RTP-1…RTP-6 / parent BE-5 and OP-4.

## Approved scope and document reconciliation

- The owner-approved ledger assigns W3.2 to the separate realtime entrypoint/process with
  independent readiness, metrics, failure isolation, and drain.
- Accepted ADR-0051 repeats that allocation: W3.3 owns admission, W3.4 durable replay, W3.5 bounded
  queues, W3.6 storage/indexing, W3.7 reconnect, W3.8 parity/load, and W3.9 traffic canary/rollback.
- The old master-plan headings still collapsed the bounded audio pipeline into “W3.2” and reconnect
  into “W3.3”. That text predates the approved nine-slice ledger. It must be reconciled before code
  so two active plans do not assign the same work to different tasks.

## Existing process symbols and behavior

- `server/src/main.mjs` is the API entrypoint. It creates one Fastify application, installs
  `installProcessShutdown`, and binds `NODE_API_BIND`. Its module import is side-effect free.
- `server/src/worker.mjs::{parseWorkerConfig,createJobWorker,installWorkerSignals}` is a second
  command in the same package/image. It owns `/health`, dependency-aware `/ready`, token-gated
  `/metrics`, polling, resource close, and SIGTERM drain, but uses its own Node `http` lifecycle.
- `server/src/lib/shutdown.mjs::{parseShutdownGraceSeconds,shutdownPhases,
  installProcessShutdown}` is the already-proven Fastify process boundary. It starts normal close,
  force-closes HTTP/raw/upgraded sockets at 80% of one budget, reserves 20% for resources, and hard
  exits if cleanup never settles. Its log prefix is currently hard-coded to “node api”.
- `server/src/app.mjs::createApplication` proves the correct Fastify settings for that controller:
  `forceCloseConnections:false`, `return503OnClosing:true`, restricted-role `onReady`, and ordered
  database/object-store `onClose` hooks.
- `server/src/lib/db.mjs::createDb` is the single restricted Postgres boundary. It can assert the
  runtime role, bound statements/connects, and close within a supplied reserve.
- `server/src/storage/audio-object-store.mjs::createAudioObjectStoreFromEnv` is the one private
  storage adapter. Both filesystem and S3 implementations expose abort-aware `assertReady` and
  idempotent `close`.
- `server/src/lib/metrics.mjs::metricsAccessAllowed` is the shared fail-closed metrics gate.
  Configured tokens win; without a token only the explicit dev control opens the endpoint.
- `server/src/container-healthcheck.mjs` is already image-generic in behavior but still calls its
  URL variable `NODE_API_HEALTHCHECK_URL` and logs “node-api”, even when Compose runs it for the
  worker.

## Current realtime and deployment state

- `server/src/realtime/protocol.mjs` owns only strict `audio.ack` construction/parsing. It imports no
  listener or crypto, exactly as W3.1 required. There is no Node realtime entrypoint today.
- `services/realtime-gateway/src/main.rs` owns the deployed port 8081 and Axum graceful shutdown.
  Its `/health`, `/metrics`, upgrade admission, queues, and audio behavior remain the compatibility
  oracle and traffic target throughout this slice.
- `docker-compose.yml` runs `node-api` and `job-worker` from one `qrai/node-backend` image. The Rust
  `realtime-gateway` is a separate image and the only realtime service used by Web. A Node realtime
  shadow does not exist.
- `server/Dockerfile` exposes only 8082/8098 and labels the image as API/worker. Release inventory
  maps the one `node-backend` digest to `node-api` and `job-worker` only.
- Prometheus scrapes API, worker, Rust API, and Rust gateway. There is no independently scraped
  Node realtime process or fixed process-readiness metric.
- `README.md`, `docs/STAGING_RUNBOOK.md`, and `monitoring/README.md` still describe exactly two Node
  commands, two-command image-id checks, and a four-target scrape topology. They are direct living
  consumers of the process shape even though the minimum AGENTS.md living-doc set is smaller.

## Caller and test findings

- `tests/node-api/graceful-shutdown.test.mjs` already proves normal drain, hung HTTP force, raw
  upgrade destruction, repeated-signal escalation, hard cleanup deadline, and live pool close for
  the API. W3.2 must reuse this controller and retain every case.
- `tests/node-api/worker-lifecycle.test.mjs` proves strict worker config, readiness/metrics, poll
  failure, and a real restricted-role child. It is a design oracle, not a module to import into the
  socket process.
- `tests/node-api/production-image.test.mjs`,
  `tests/release/release-artifact-consumption.test.mjs`, and
  `scripts/lib/deployable-images.mjs` pin the two current commands to one image. Adding a third
  command changes those exact consumers but must not add a release image key.
- `docker-compose.release.yml`, `scripts/http-canary-image.mjs`, the release selection/controller
  helpers, and their release/canary/rollback tests enumerate every Compose consumer of an immutable
  image. Mapping the third command to `node-backend` therefore changes candidate/previous running
  image evidence counts even though the digest document correctly remains six artifacts.
- `tests/observability/http-canary-monitoring.test.mjs` exactly pins scrape jobs, targets, Compose
  health dependencies, alerts, and absence of identity labels. A realtime scrape/alert therefore
  requires an intentional update rather than an untested YAML edit.
- `tests/contract/verify-invocations.test.mjs` and `scripts/verify.sh` require every new lifecycle
  proof to run exactly once.
- `tests/contract/node-backend-decisions.test.mjs` reads staging operations text and therefore must
  remain green when the same-image/process-role instructions become three-command instructions.

## Selected design constraints

- Use Fastify already present in `server/package.json` and the proven shared shutdown controller;
  do not create a second server package, image, or WebSocket framework in this slice.
- The realtime process initially exposes only `/health`, `/ready`, and `/metrics`. A 404 for all
  other HTTP paths and refusal of upgrades proves this is a process shell, not an accidental
  partial protocol implementation.
- Liveness is process-only. Readiness is bounded and verifies the dependencies the final ingress
  will need: restricted Postgres, private object storage, job-worker readiness/capacity boundary,
  and loaded-model ASR readiness. Dependency detail remains internal and is reduced to four closed
  low-cardinality classes.
- The restricted-role assertion is a pre-listen security gate. Later dependency outages degrade
  `/ready` while `/health` stays live, allowing recovery without restart storms.
- One `SHUTDOWN_GRACE_SECS` budget sizes readiness cancellation, Fastify drain, raw-socket force,
  database close, and object-store close. No independent timer may extend the outer deadline.
- The Node realtime Compose service is internal-only, uses the same immutable backend image, mounts
  the same private storage boundary, and has no Web/Rust dependency edge. Killing it must not stop
  API, worker, or the Rust gateway; killing those roles must not stop its process liveness.
- Release and rollback evidence must observe the shadow container under the same backend digest.
  It is not added to traffic-switch or reverse-traffic ordering because W3.2 gives it no traffic.
- Metrics use only process/dependency/outcome labels. Tenant, user, learner, session, chunk, object
  key, trace, dependency URL, and exception text are forbidden.

## Primary evidence

- Pinned Node 22.13.1 HTTP close/upgrade semantics:
  <https://nodejs.org/download/release/v22.13.1/docs/api/http.html>.
- Pinned Fastify 5.11 close lifecycle and `return503OnClosing` behavior, already inspected under the
  installed package and recorded in W2.13:
  <https://fastify.dev/docs/latest/Reference/Server/#close>.
- Existing executable lifecycle evidence:
  `tests/node-api/{graceful-shutdown,worker-lifecycle,standalone-lifecycle}.test.mjs`.

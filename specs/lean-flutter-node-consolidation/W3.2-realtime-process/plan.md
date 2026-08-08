# W3.2 plan — isolated Node realtime process lifecycle

**Status:** APPROVED under the owner-approved W0–W7 consolidation plan<br>
**Approved-by:** Repository owner — parent plan approval plus explicit persistent “approved”,
“proceed”, and “continue” instructions<br>
**Criteria:** RTP-1…RTP-6; parent BE-5 and OP-4

## Decision

Add one realtime command to the existing `server` package and immutable Node backend image. Reuse
Fastify, the restricted database boundary, private object-store boundary, metrics access gate, and
the already-proven bounded shutdown controller. The new process is an internal observation shadow:
it exposes only `/health`, `/ready`, and `/metrics`, publishes no host port, accepts no upgrade, and
receives no Web or gateway traffic.

Readiness is honest before traffic exists. It verifies the restricted Postgres role, private object
store, job worker, and loaded-model ASR through bounded checks. Liveness remains process-only.
Metrics expose only fixed process/dependency classes. The Rust gateway remains the deployed oracle.

## Test-first implementation sequence

1. Add red `tests/realtime/process-lifecycle.test.mjs` cases for a missing entrypoint, strict config,
   side-effect-free import, exact three-route surface, fail-closed metrics, process-only health,
   four-class deep readiness, generic fault responses/logs, bounded dependency probes, ordered
   resource close, raw-upgrade force, and real API/realtime child failure isolation.
2. Add the exact-one invocation assertion to `tests/contract/verify-invocations.test.mjs`, then
   register the lifecycle suite once in `scripts/verify.sh`. Add red package/image/Compose/release
   and monitoring expectations to their existing direct-consumer tests.
3. Implement `server/src/realtime/main.mjs` as one side-effect-free composition/entrypoint module.
   Use Fastify already in the production graph, strict whole-number/address/URL parsing, bounded
   dependency checks, three routes only, and fixed-cardinality process metrics. Do not register an
   upgrade handler or import W3.3+ behavior.
4. Extend `installProcessShutdown` only with a fixed validated role label while preserving “node
   api” as the default. Install it before listen; use one grace budget for probe cancellation,
   force/hard exit, object-store close, and database close. Preserve all W2.13 tests.
5. Make the image healthcheck naming role-neutral, add the realtime command/port to the existing
   package image, and add an internal `node-realtime` Compose shadow. Share the backend image digest
   and private storage mount; depend on migrations/worker/ASR readiness, expose no host port, and
   leave Web plus Rust gateway edges byte-for-byte unchanged. Add the same command to the immutable
   release overlay and Docker healthcheck smoke without creating another artifact.
6. Extend release image ownership and monitoring to the third Node command without adding an image
   key. Candidate/previous image evidence must observe the extra container under the same digest,
   while HTTP/realtime traffic-switch and reversal order remain unchanged. Add one private
   Prometheus target and a closed-label process/readiness alert; keep Rust gateway audio-loss
   metrics authoritative until W3.8/W3.9.
7. Update the README and living architecture/testing/decision/staging/monitoring text with only
   implemented current-state claims. Run focused process, shutdown, image, release, monitoring,
   secret, and invocation suites, then the exact canonical gate with live restricted Postgres. Do
   not close W3.2 until the exact pushed SHA's required CI is green and
   `scripts/update-ledger.sh W3.2 RTP-1..RTP-6` succeeds.

## Exact implementation surface

- New runtime: `server/src/realtime/main.mjs`.
- Shared runtime edits: `server/src/lib/shutdown.mjs`,
  `server/src/container-healthcheck.mjs`, `server/package.json`, `server/Dockerfile`.
- Topology/release/monitoring: `docker-compose.yml`, `docker-compose.release.yml`,
  `.github/workflows/docker-build.yml`, `scripts/lib/deployable-images.mjs`, affected immutable
  image/canary/rollback controllers, and `monitoring/{prometheus.yml,
  docker-compose.monitoring.yml,alerts.yml}`.
- Proof: new `tests/realtime/process-lifecycle.test.mjs`; existing
  `tests/{node-api/production-image,release/release-artifact-consumption,
  release/release-deployment-selection,release/http-canary-image,
  release/canary-rollback-evidence,observability/http-canary-monitoring,
  contract/http-canary-topology,contract/verify-invocations}.test.mjs`; `scripts/verify.sh`.
- Living docs: `README.md`, `docs/{DECISIONS,TESTING,STAGING_RUNBOOK}.md`,
  `docs/architecture/10-10-platform.md`, `monitoring/README.md`, and the umbrella W3 decomposition.

## Non-goals and rollback

- No socket upgrade, ticket parsing, Origin/no-Origin decision, replay state, queue, frame handling,
  audio storage/indexing, client reconnect, or traffic selection.
- No new package, image key, runtime dependency, Redis, NATS, schema, migration, or public port.
- Rollback removes the internal `node-realtime` Compose command and its scrape target. API, worker,
  Rust gateway, Web traffic, stored data, and protocol fixtures remain unchanged.

## Verification boundary

Focused proof must be green hermetically; live restricted-role/pool-close cases may skip only when
the canonical environment truly lacks Postgres. Final closure requires:

```sh
PATH=/Users/hawzhin/flutter/bin:$PATH \
MIGRATION_TEST_ADMIN_URL=postgresql://hawzhin@127.0.0.1:5433/quran_ai \
bash scripts/verify.sh
```

The W3.2 ledger row remains unchecked until local verification and required remote CI are both green.

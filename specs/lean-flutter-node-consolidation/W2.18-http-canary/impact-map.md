# W2.18 impact map — HTTP canary, immutable deployment, and rollback

Serena caller mapping was used for JavaScript symbols; YAML/nginx consumers were mapped directly.
No implementation surface may be added outside this map without updating callers and tests first.

| Symbol/surface to change | Direct callers/consumers | Required preservation and proof |
|---|---|---|
| deployable-service/image identity inventory (new single owner) | release image/build/manifest/smoke evidence; workflows; release Compose | One `node-backend` image for API+worker plus least-privileged `migration-runner`; bare evidence keys map to exact GHCR digest refs; no copied arrays |
| `release-images::{SERVICES,imageTag,tagsToPrune,main}` | release-image workflow; `release-images.test.mjs` | Replace ephemeral host-tag claim with durable registry refs; machine JSON stays separate from logs; retention never deletes candidate/previous |
| `release-build-evidence::parseImageDigests` | `release-build-evidence::main`; build/manifest tests | Consume canonical service-keyed JSON only; reject tag-only, missing, extra, duplicate, or malformed digests |
| `release-manifest` image/build assertions | release challenge; signed manifest generation/verification | Bind candidate and previous manifests plus topology hash; preserve clean-tree/signature/material-hash gates |
| `smoke-evidence::createCandidateBoundSmokeSummary` | `smoke-all`; smoke/release manifest validators | Add actual container image IDs and target topology; source processes cannot satisfy candidate-image proof |
| `.github/workflows/release-image.yml` | tag/manual releases; uploaded evidence | Build/push digest-addressable GHCR artifacts using scoped token; publish valid JSON and immutable retention evidence |
| `.github/workflows/release-challenge.yml` | release operator; manifest challenge | Resolve an explicit producer/run, execute candidate images with disposable DB, never validate manifest-only as runtime proof |
| `.github/workflows/{ci,docker-build}.yml` | pull requests/main | Trigger on canary/nginx/overlay changes; full Node candidate health/smoke; required checks remain unchanged or stronger |
| `docker-compose.yml` plus release/canary overlay | local dev, candidate deploy, monitoring, runbooks | Base remains Rust-safe; release uses no `build`; API+worker share exact digest; Rust stays healthy; canary switches Web and gateway index together |
| `apps/web/Dockerfile` and nginx HTTP/TLS templates | Web image; base/TLS/canary Compose; security-header tests | Runtime API upstream has an explicit Rust/Node value; same-origin/CSP/TLS/WS rules unchanged; invalid/missing target fails boot |
| `server/main::compatibilityRouteKeys` and `app::createApplication` (consumed, not redesigned) | Node entrypoint; parity shell; Compose canary | Exact retained keys derive from route manifest; unmatched agent/password transition stays Rust; `<unmatched>` measures fallback |
| `routes/index::ROUTES` and route manifest (consumed) | Node registration; cutover checker; authz/parity suites | 39 retained routes are the canary set; two agent extras and owner-gated device routes cannot silently enter it |
| realtime gateway `PLATFORM_API_URL` deployment wiring | gateway audio index path; gateway E2E | Canary points metadata indexing to Node with store-before-index/idempotency unchanged; rollback returns it to Rust with Web API |
| `cutover-readiness::{checkTrafficShare,checkRollbackArtifact,main}` | contract checker and CLI | Inspect rendered traffic target and consumable candidate/previous digests; a generic build-pattern hit cannot report rollback ready |
| `load-test::{options,default,handleSummary}` | manual/release k6 runs | Target Node candidate; classroom/ramp/soak scenarios; truthful thresholds and candidate-bound machine summary; no tokens/audio logged |
| canary controller/state machine (new) | release drill workflow/operator; controller tests | Dependency-injected commands/probes; explicit prepare→canary→observe→promote/rollback states; every stop path rolls back and verifies |
| canary evidence validator plus signed monitoring/CI/approval policy (new) | release gate; manifest; protected monitoring/CI attestors; owner/security/SRE approval validator | Reject stale, unsigned, wrong-role, wrong-image, source-process, missing-route/check, threshold-failed, incident-only, privacy-incomplete, or un-rehearsed evidence; automation validates but never creates human approval |
| `metrics::createMetrics` output (consumed) | `createApplication`; Node `/metrics`; Prometheus | Preserve labels/contracts; use local path vs `<unmatched>` without tenant/user/trace labels |
| `worker::renderStateMetrics` and job runtime `renderMetrics` (consumed) | worker `/metrics`; Prometheus/alerts | Observe queue/running/retry/dead/fencing outcomes without sensitive labels |
| `monitoring/{prometheus,alerts,grafana-dashboard,docker-compose.monitoring}.yml` | Prometheus/Grafana/operator | Scrape Node, worker, Rust; candidate-specific stop alerts; no high-cardinality or learner identifiers; receiver remains human-configured |
| `smoke-api`, `http-canary-image` evidence/probe runner, API parity/hostile/effect harnesses | canonical/release workflow | JWT-authenticated candidate-image mode proves actual containers; retained Node routes work with Rust stopped; ordinary local gate stays hermetic |
| `scripts/verify.sh` | local and required CI gates | Register every hermetic test once; `--release` requires live candidate evidence and never fabricates unavailable infrastructure |
| ADR-0022, architecture/testing/staging/operations docs | developers, release operator, readiness guards | Record GHCR decision, exact selectors, bounded cohort, stop/rollback commands, and external human gates without stale rebuild claims |

## Required regression groups

- Release image/build/manifest/smoke evidence, signing, dirty-tree, service-identity, and retention tests.
- Compose/nginx HTTP+TLS topology, production image, security headers, route registry, and cutover checker.
- Direct and through-Node parity, hostile input, effect parity, privacy, tenant/RLS, feedback gate,
  audio indexing, gateway loss/idempotency, durable jobs, dependency timeouts, and graceful shutdown.
- Canary controller stop-condition mutation tests, candidate evidence validation, k6 summary tests,
  actual-image release smoke, rollback drill proof, canonical gate, remote CI, and human signatures.

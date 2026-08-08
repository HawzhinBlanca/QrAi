# W3.3 impact map — realtime admission and ticket parity

| Symbol/boundary | Direct callers/consumers mapped before edit | Planned change | Regression obligation |
|---|---|---|---|
| new `server/src/realtime/admission.mjs` | W3.3 Fastify pre-validation; future W3.4 replay and W3.5 socket handler; ticket-boundary tests | Pure Origin/ticket/lifetime/rate decision, frozen claims/trace, fixed counters; no persistence | all fixture/hostile/origin/rate boundaries, generic statuses, no raw token persistence or metric labels |
| `ticket.mjs::validateRealtimeTicket` (reuse unchanged) | `routes/recitation.mjs::indexAudioChunk`; Node vectors; future admission | Validate HMAC/session/retention/expiry once; admission adds tenant and 3,600-second bound after signature | existing ticket/API/gateway/E2E suites plus all six vectors through admission |
| `admission.mjs::createTokenBucketLimiter` (reuse unchanged) | HTTP `app.mjs::createApplication`; `node-boundary.test.mjs`; future realtime admission | Reuse separate realtime instance with direct/trusted `request.ip`; no broker/global state | existing HTTP burst/refill/LRU/proxy proof plus realtime 200/50/429/proxy cases |
| `realtime/main.mjs::{parseRealtimeConfig,createRealtimeApplication,startRealtimeProcess,renderMetrics}` | W3.2 lifecycle suite; process entrypoint; Compose; storage/DB/shutdown boundaries | Strict admission config, websocket plugin registered before a subsequent route plugin, exact socket route, fixed counters, default 1013 close; ordinary HTTP on the route remains 404 | W3.2 health/ready/private metrics/fault/drain/failure isolation plus real pre-101 refusals and admitted close frame |
| `server/package.json` + lockfile | server build; `tests/node-api/standalone-lifecycle.test.mjs` exact dependency boundary; production deploy graph; Docker image; audit/licence/SBOM gates | Add exact official `@fastify/websocket` 11.3.0 only | frozen install, exact manifest assertion, audit, licence, lint/type/build, clean image smoke; no optional addon/second package |
| Rust `validate_origin/check_ticket/audio_ws` (oracle, unchanged) | deployed Web/Flutter traffic; Rust unit tests; real hostile sweep | No source change; share named hostile ticket cases with Node proof | all Rust gateway tests and real process liveness remain green |
| `tests/gateway/ws-hostile-input.test.mjs` | canonical real Rust binary gate | Import shared ticket-case builder; preserve frame/process cases | identical named ticket corpus executed by Rust and Node; seven existing tests remain |
| `tests/realtime/process-lifecycle.test.mjs` | canonical W3.2 proof; `createRealtimeApplication` callers | Replace “all upgrades 404” assertion with exact-route authorized/refused lifecycle and preserve every process claim | strict config, readiness/fault/metrics, unavailable socket, shutdown and API isolation |
| `docker-compose.yml::node-realtime` | production-image/topology tests; release overlay; monitoring dependency | Inject ticket/tenant/Origin/native/rate/proxy inputs; stay internal and unrouted | parsed exact env, no host port/Web edge/Rust edge/proxy target; same image and healthcheck |
| `docker-compose.native.yml` | native Flutter deployments; legacy-insecure security test | Apply the narrow missing-Origin policy to Rust and Node realtime roles | exact two-role overlay, base default remains off, disallowed supplied Origin remains rejected |
| process admission metrics | private `/metrics`; Prometheus existing node-realtime scrape; lifecycle/monitoring tests | Add four closed outcome counters, no new scrape/alert topology | exact label set and absence of ticket/Origin/tenant/learner/session/trace/URL/error labels |
| `scripts/verify.sh` | local canonical gate and CI | Add W3.3 suite once; retain Rust real hostile suite once | exact-one invocation guard |
| `tests/contract/realtime-decisions.test.mjs` + decisions/architecture/testing/staging/README/monitoring docs | operators, W3.4–W3.9 implementers, reviewers | Record supported adapter, admitted-but-unavailable shadow, security config, and remaining gates | ADR-0052 and living docs match actual topology and keep the focused gate documented once |

Implementation discovery: `@fastify/websocket` installs its route transformation through an
`onRoute` hook, so placing top-level routes immediately after `register(websocket)` is too early in
Fastify's plugin queue. The process therefore registers all routes in the next encapsulated plugin.
The rejection transport proof disables Node's global keep-alive agent because the adapter closes a
rejected upgrade after its empty HTTP response; reusing that closing connection would test client
pooling rather than admission. The legacy environment scanner was also anchored to real assignment
lines after the new explanatory Compose comment exposed its prose false-positive. A stronger
near-miss check also found Fastify's default 404 document echoed the credential-bearing URL; the
realtime application now owns a bodyless 404 and disables automatic request-line logging.

## Explicitly unaffected callers

- Web and Flutter continue to mint through Node/platform API and connect only to the Rust gateway.
- W3.3 adds no replay claim, migration, Redis change, Postgres admission query, audio/ack/storage/index
  behavior, client reconnect, public port, proxy route, traffic switch, or release artifact key.
- API/worker routes, authentication/login policy, RLS, Quran data, inference/evaluation evidence,
  audio privacy, and learner-facing source/review gates do not change.

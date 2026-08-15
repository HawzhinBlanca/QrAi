# W3.2 impact map — isolated Node realtime process lifecycle

| Symbol/boundary | Direct callers/consumers mapped before edit | Planned change | Regression obligation |
|---|---|---|---|
| new `server/src/realtime/main.mjs` composition + entrypoint | package lint/build; production image; Compose Node shadow; lifecycle tests; future W3.3–W3.6 modules | Side-effect-free Fastify composition, strict bind/dependency config, three infra routes only, real process main | import has no listen; invalid config refuses; real child health/ready/metrics; every other route/upgrade unavailable |
| `server/src/lib/shutdown.mjs::installProcessShutdown` | API `main.mjs`; graceful-shutdown tests; future realtime process | Add one validated fixed role label with API-preserving default; reuse identical normal/force/hard behavior | all existing API completing/hung/upgrade/repeated/hard/pool-close cases plus realtime close-order cases |
| `server/src/lib/{db,metrics}.mjs` | API routes, worker, DB/security/fault tests | Reuse unchanged restricted-role/close and metrics-access facades from realtime composition | privileged role refuses pre-listen; token/no-token matrix; dependency text never leaks |
| `server/src/storage/audio-object-store.mjs::createAudioObjectStoreFromEnv` | API, worker, inference, privacy/retention/E2E tests | Reuse one injected store for readiness and ordered close; no audio call yet | filesystem/S3 readiness faults, abort bound, exactly-once close, existing storage lifecycle |
| `server/src/container-healthcheck.mjs` + Compose health URL env | Node API and worker containers; Dockerfile; production-image test | Make naming process-role neutral and point each of three commands at its own `/ready` | healthcheck success/refusal/timeout; parsed role-specific Compose URLs |
| `server/package.json` | standalone-lifecycle exact lint assertion; pnpm build/typecheck; Docker deploy | Audit the existing realtime lint/build coverage; its `src/realtime/*.mjs` glob already covers the new entrypoint, so no manifest or dependency change is required | exact package manifest, syntax/type/build, one production graph |
| `server/Dockerfile` | Docker CI; Compose; release image; SBOM/licence proof | Describe API/worker/realtime roles and expose internal 8081 in the same non-root image | production-image static proof and actual image smoke |
| `docker-compose.yml::node-realtime` | local/staging topology; monitoring overlay; image-selection/release scripts | Add internal shadow command, dependency config, shared storage, bounded health/stop; no host port and no traffic edge | parsed topology, API/Rust target immutability, process-kill isolation |
| `scripts/lib/deployable-images.mjs::node-backend.composeServices` + `docker-compose.release.yml` | release build/manifest/smoke/deployment selectors; actual-image/canary/rollback controllers; release contract tests | Map `node-realtime` to the existing backend digest and immutable release overlay; add no image key or traffic-switch role | exact release inventory/digest document remain six keys; candidate/previous running evidence observes all three Node commands; traffic reversal order unchanged |
| `.github/workflows/docker-build.yml` native healthcheck smoke | Docker CI and HTTP-topology workflow contract | Use the role-neutral healthcheck URL name while retaining the same Node API smoke behavior | workflow static contract plus actual image healthcheck |
| monitoring Prometheus/Compose/alerts | monitoring contract, Grafana, operators | Add private Node realtime scrape and a process-down/readiness alert with closed labels; keep Rust gateway signal separate | YAML parse, exact target/token, alert presence, no identity labels |
| `scripts/verify.sh` Node command | local canonical gate and CI | Invoke the new process lifecycle suite exactly once | `verify-invocations.test.mjs` exact-one assertion |
| umbrella plan + `README.md`, architecture/testing/decision/staging/monitoring docs | developers, operators, reviewers, W3.3–W3.9, release governance | Reconcile nine-slice W3 allocation; document the third same-image command, internal health/metrics, and no-traffic status without claiming a listener | realtime decision, node-backend decision, and living-doc guards; manual commands match Compose |

## Explicitly unaffected callers

- Web and Flutter realtime clients continue to mint tickets and connect only to the Rust gateway.
- Rust ticket validation, Origin policy, replay behavior, queues, storage/indexing, and metrics remain
  the oracle and are not modified.
- API routes, authentication, RLS policies/migrations, Quran data, inference results, and
  learner-facing feedback gates do not change.

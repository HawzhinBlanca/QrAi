# W2.18 research — candidate-bound Node HTTP canary and rollback

**Status:** research only; no runtime/test behavior changed — **Target:** W2.18 / OP-3 / GOV-1

## Grounded symbols and data flow

- `server/src/main.mjs::compatibilityRouteKeys` parses `NODE_API_PORTED`; an explicit
  `PLATFORM_API_UPSTREAM` selects reversible compatibility mode, while no upstream selects the full standalone registry.
- `server/src/app.mjs::createApplication` serves only selected keys in compatibility mode and proxies
  unmatched traffic to Rust. Its `<unmatched>` metrics label is the measurable fallback share.
- `server/src/routes/index.mjs::ROUTES` has all 39 retained operations, two transition-only agent
  routes, and three owner-gated device routes. `scripts/cutover-readiness.mjs::checkTrafficShare`
  proves registry coverage, not deployed traffic.
- `docker-compose.yml` keeps `node-api` internal, selects only health/readiness, and sends Web nginx
  plus realtime-gateway indexing to `platform-api`. Both `apps/web/nginx*.conf` files hard-code Rust.
- `apps/flutter/lib/main.dart` bakes `QRAI_API_BASE_URL`; there is no runtime cohort selector.
- `tests/api-parity/lib/harness.mjs::{startApi,startShell}` proves Rust directly and through Node;
  the canonical run passed 389 cross-runtime and 332 through-Node tests, including hostile/effect
  cases, but not from a candidate image under deployed load.
- `server/src/lib/metrics.mjs::createMetrics`, `server/src/worker.mjs::renderStateMetrics`, and
  `server/src/jobs/runtime.mjs::renderMetrics` expose useful Node/worker signals. `monitoring/**`
  scrapes, alerts, and dashboards only Rust.
- `scripts/load-test.js` is manual 5-VU/10-second Rust+worker load. It is absent from CI/release,
  does not target Node HTTP, and produces no candidate-bound soak evidence.
- `scripts/release-images.mjs::{SERVICES,imageTag,tagsToPrune,main}` creates host-local SHA tags;
  `scripts/release-build-evidence.mjs::parseImageDigests` and Compose are their consumers in theory.

## Current result

- `node scripts/cutover-readiness.mjs`: 5 mechanical checks met; operational proof is unmet because
  P5.5/P5.6 remain open; P1.7/P4.1 still require people. The script correctly cannot report GO.
- Public HTTP traffic is still 100% Rust. There is no bounded canary ingress, observation-window
  state, automated stop condition, promotion controller, or rehearsed application rollback.
- Rust and Node share the worker/inference boundary, so keeping the Rust image live is compatible
  with a reversible HTTP-only canary; writes must never be shadowed or duplicated.

## Release and rollback defects

- `.github/workflows/release-image.yml` runs on `ubuntu-latest`; GitHub documents that its VM is
  decommissioned after the job, so host-local retained Docker tags do not survive as rollback
  artifacts: https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners
- Release output keys are `qrai/<service>:<sha>`, while build evidence requires bare service keys;
  the workflow also tees human log lines and JSON into one nominal `.json` artifact.
- Compose has no candidate/prior-digest deployment overlay. Node Compose uses
  `qrai/node-backend:<tag>`, while release creation names `qrai/node-api:<sha>`; other services still
  build from source. Docker's Compose contract can address an exact digest, but this repo does not:
  https://docs.docker.com/reference/compose-file/services/#image
- `checkRollbackArtifact` accepts a generic build-pattern hit and therefore overstates readiness;
  release verification binds declared digests but normally executes source-checkout processes.

## Risks and planning constraints

- A safe slice needs one explicit candidate selector, one explicit previous selector, an ingress
  switch that cannot silently split writes, and exact image/process identity in every evidence row.
- The canary must exercise Web/API and gateway indexing through Node while Rust remains healthy and
  immediately selectable; agent/password compatibility stays on Rust during the observation window.
- Stop conditions need Node HTTP, worker backlog/dead jobs, DB/storage/readiness, privacy failure,
  tenant isolation, lost chunks, and learner-feedback withholding signals without sensitive labels.
- Old load/DR logs target retired topology or unbound debug processes and cannot prove W2.18; `tests/release/canary-rollback-evidence.test.mjs` does not exist.
- Remote CI, deployed observation, Alertmanager/on-call routing, and human GO/security/SRE signatures remain external gates.

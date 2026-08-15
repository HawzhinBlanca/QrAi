# W2.18 plan — candidate-bound Node HTTP canary and rehearsed rollback

**Status:** IMPLEMENTATION IN PROGRESS — T1–T4 and the T5 closure gate are locally verified; T5 external release evidence remains open<br>
**Approved-by:** repository owner — active goal continuation on 2026-08-07<br>
**Criteria:** OP-3, GOV-1 (`spec.md` HCR-1…HCR-10)

## Decision

Keep one repository and the existing Node/Rust compatibility boundary. Use GHCR, the repository's
existing GitHub identity, one release Compose overlay, and the existing unprivileged nginx image;
do not add Kubernetes, a service mesh, a feature-flag service, a second API, or a database table.
Amend ADR-0022 from ephemeral local tags to durable registry artifacts because GitHub-hosted runner
disks are destroyed and cannot be rollback storage.

The canary is an explicit isolated environment/approved actor cohort, not a random percentage.
Nginx and realtime indexing switch together to Node compatibility mode with exactly the 39 retained
routes derived from the contract manifest. Rust remains live for transition routes and immediate
reversal. Mutable requests execute once only; comparison comes from existing effect invariants, not
dual writes. A small dependency-injected controller owns prepare, observe, stop, and rollback.

## Implementation sequence

1. **Make artifact claims true before routing traffic.** Add red evidence/consumption guards, create
   one deployable identity inventory (`node-backend` owns both Node roles; the one-shot
   `migration-runner` remains a separately least-privileged artifact), amend ADR-0022, and make
   release-image publish service-keyed GHCR digests as valid machine JSON. Add a no-build release
   overlay that consumes candidate and previous manifests and proves every running container's image.
2. **Create one explicit reversible HTTP topology.** Convert existing HTTP/TLS nginx configs to the
   image's supported runtime templates with a closed Rust/Node upstream value. Add a canary overlay
   that computes the exact retained route set from the manifest, switches Web API plus gateway index
   traffic to Node, and keeps Rust healthy. Base Compose remains Rust-safe; no random split or write
   shadowing is introduced.
3. **Prove the actual candidate image.** Extend smoke/parity harnesses with an explicit image mode,
   bind evidence to inspected container image IDs, run retained hostile/effect/privacy/tenant/audio
   proofs through Node, then stop Rust and prove no retained route silently falls back. Transition
   routes are separately proven to require the live Rust oracle during the window.
4. **Add observation and automatic stop.** Scrape Node, worker, and Rust; add low-cardinality canary
   alerts and a testable controller state machine. Upgrade k6 to candidate-targeted classroom,
   durable-job, burst, and soak scenarios with immutable thresholds. Any readiness/SLO/privacy/
   tenant/chunk/feedback/job stop signal performs Web+gateway reversal, deploys the previous digest
   manifest, verifies health/effects, and records failure instead of retrying until green.
5. **Close only with real operations.** Run the exact candidate image suite, load/soak, deliberate
   stop-condition drill, application rollback, and canonical gate; record timings and hashes. Update
   staging/architecture/testing/operations docs. Keep W2.18 unchecked until required remote CI and
   signed, unexpired owner/security/SRE approvals exist; no automation may fill those signatures.

## Test map

| Criterion | Required automated proof |
|---|---|
| HCR-1 | `scripts/release-images.test.mjs`; `tests/release/release-artifact-consumption.test.mjs` |
| HCR-2 | `tests/contract/http-canary-topology.test.mjs`; release manifest/build-evidence tests |
| HCR-3 | `tests/contract/http-canary-topology.test.mjs`; `tests/e2e/http-canary-effects.test.mjs` |
| HCR-4 | `tests/e2e/http-canary-effects.test.mjs`; existing effect/privacy/audio-index parity suites |
| HCR-5 | `tests/release/canary-rollback-evidence.test.mjs`; release signing/dirty-tree tests |
| HCR-6 | `tests/release/http-canary-image.test.mjs`; hostile-input and through-Node parity suites |
| HCR-7 | `scripts/load-test.test.mjs`; `tests/release/canary-rollback-evidence.test.mjs` |
| HCR-8 | `tests/observability/http-canary-monitoring.test.mjs`; worker metrics/lifecycle suites |
| HCR-9 | `tests/release/http-canary-controller.test.mjs`; `canary-rollback-evidence.test.mjs` |
| HCR-10 | `tests/release/canary-rollback-evidence.test.mjs` in `verify.sh --release` |

## Exact implementation surface

- Release truth: `scripts/{release-images,release-build-evidence,release-manifest,smoke-evidence,
  release-evidence-summary,cutover-readiness}.mjs`, one small shared deployable inventory, their tests,
  and `.github/workflows/{release-image,release-challenge,docker-build,ci}.yml`.
- Topology: `docker-compose.yml`, one release/canary overlay, `apps/web/{Dockerfile,nginx.conf,
  nginx-tls.conf}` as templates, gateway target wiring, topology/security/image tests.
- Proof: candidate controller/evidence modules, `scripts/load-test.js`, monitoring configs, existing
  smoke/parity harnesses, named new tests above, and `scripts/verify.sh`/release mode.
- Living operations: ADR-0022, architecture, testing, staging, operations/readiness docs, and W2.18
  evidence. No canonical Quran bundle, DB migration, public route, or learner feedback shape changes.

## Non-goals, risks, and rollback

- GHCR availability becomes a release/deploy dependency; the currently running candidate and its
  previous manifest must remain locally cached so an incident reversal does not require a pull.
- Nginx template substitution is deployment-time only and accepts a closed Rust/Node target; missing
  or invalid selection fails container startup. CSP, TLS, same-origin cookies, and WS policy remain.
- The controller is not a production GO authority. It can stop/rollback; only named humans can
  approve promotion. A failed live drill remains failed evidence and is never overwritten.
- Rust `platform-api` is retained through the observation window. Deletion belongs to W7.5 after
  this task, later release gates, and the retained rollback window are complete.

## Implementation ledger

- [x] T1 — truthful durable image identity, GHCR publication path, release overlay, and ADR amendment.
- [x] T2 — explicit Node HTTP/gateway canary topology with exact route ownership and Rust reversal.
- [x] T3 — actual-image hostile/effect/privacy/tenant/audio proof and candidate-bound evidence
  machinery; deployed candidate execution remains explicitly in T5.
- [x] T4 — Node/worker/Rust monitoring, candidate load/soak, stop controller, and rollback mutation proof.
- [ ] T5 — release-closure validation and living docs are locally verified; live canary + deliberate
  rollback evidence, remote CI, and three independent human signatures remain external and open.

**HUMAN GATE:** Fill `Approved-by:` above to authorize implementation. Until then W2.18 remains
research/planning only; no release, runtime, Compose, workflow, monitoring, or test file may change.

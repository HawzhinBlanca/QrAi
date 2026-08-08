# W2.17 plan — one server-owned inference/worker boundary

**Status:** COMPLETE; local and exact-candidate remote proof are green<br>
**Approved-by:** repository owner — explicit continuation goal on 2026-08-07<br>
**Criteria:** BE-1, BE-4, BE-6 (`spec.md` MLB-1…MLB-9)

## Decision

Consolidate in place; do not create a new project. Move the ML implementation into
`server/src/inference/` and run it only in the existing `job-worker` process. The API becomes a
durable enqueue-and-wait boundary. The worker's private HTTP listener temporarily serves the exact
key-gated Rust compatibility allowlist, including gateway audio ingestion, so the old ML service
tree/image can be removed without breaking today's Rust traffic or W2.18 rollback.

## Implementation sequence

1. **Relocate behavior before changing it.** Add red ownership/relocation guards, then move
   alignment, Tajweed, attribution, fixtures, canonical loading, ASR/acoustic orchestration,
   inference audit, audio loading/storage/retention, and the compatibility router into cohesive
   `server/src/inference/{alignment,tajweed,model-attribution,transcription,audio,runtime,compat}.mjs`
   modules. Move ML tests to `tests/inference/`; preserve exact outputs and canonical bytes.
2. **Make the worker the execution owner.** Compose a dependency-injected `createInferenceRuntime`
   in `worker.mjs`. Change `createWorkflowHandlers`, `prepareSessionFinalization`, and
   `prepareSessionEvaluation` to call it directly. Replace `runInlineJob` with a wait-only job poller;
   remove workflow/runtime execution from the API. Only the existing key-gated private client for
   the non-durable alignment route may cross from API to worker.
3. **Join audio/privacy/lifecycle once.** Mount the same object-store instance into worker jobs,
   compatibility ingress, privacy/read compatibility, transcript loading, and one guarded retention
   sweep. Propagate the parent signal and drain HTTP, jobs, sweep, inference audit, storage, and DB in
   a bounded order. Keep Node privacy/playback on direct injected storage with fail-closed composition.
4. **Replace the old process, not its behavior.** Extend the worker's private listener with a closed
   ML-key allowlist. Repoint Node's non-durable alignment client plus current Rust platform/gateway
   consumers to it. Delete `services/ml-inference` and its Dockerfile only after parity/E2E proofs;
   run `node-api` and `job-worker` from `server/Dockerfile`, keep ASR separate, and update release,
   smoke, load, Compose, SBOM/evidence, readiness, and static inventories honestly.
5. **Close the local implementation with operational proof.** Update ADR-0050, architecture,
   testing, data inventory, staging, threat model, backup/restore, and evidence. Run each focused
   red→green proof, then the exact live-Postgres canonical gate. Do not check the umbrella task
   without required remote CI, and W2.18 does not begin automatically.

## Test map

| Criteria | Required automated proof |
|---|---|
| MLB-1 | `tests/contract/inference-module-boundary.test.mjs`; relocated `tests/inference/{alignment,tajweed,model-attribution,golden-regression}.test.mjs` |
| MLB-2 | `tests/jobs/local-inference-worker.test.mjs`; `tests/e2e/{real-audio-finalize,model-provenance-roundtrip,durable-workflows}.test.mjs`; `tests/api-parity/session-finalize-parity.test.mjs` |
| MLB-3 | `tests/jobs/api-job-wait.test.mjs`; `tests/faults/dependency-timeouts.test.mjs`; static no-inference-import assertion in the boundary test |
| MLB-4 | `tests/jobs/inference-cancellation.test.mjs`; existing job crash/fencing suites and dependency timeout suite |
| MLB-5 | `tests/inference/compatibility-ingress.test.mjs`; `tests/gateway/{audio-retention-e2e,index-failure-e2e}.test.mjs`; relocated chunk-overwrite/rate-limit tests |
| MLB-6 | `tests/e2e/{audio-lifecycle,teacher-audio-index}.test.mjs`; `tests/observability/privacy-erasure-journey.test.mjs`; privacy/playback parity |
| MLB-7 | `tests/inference/audio-retention-worker.test.mjs`; `tests/node-api/worker-lifecycle.test.mjs` |
| MLB-8 | `tests/contract/inference-compatibility-surface.test.mjs`; Rust ML/privacy/review/finalize and gateway parity/E2E tests |
| MLB-9 | `tests/node-api/production-image.test.mjs`; release manifest/image/build-evidence tests; worker readiness/lifecycle tests |

## Exact implementation surface

- New/moved: `server/src/inference/**`, `tests/inference/**`, focused job/contract tests above.
- Refactor: `server/src/{app,main,worker}.mjs`, `server/src/jobs/{workflows,wait-for-job}.mjs`,
  `server/src/routes/{session-writes,ml-proxy,privacy,review,infra}.mjs`, `server/package.json`,
  `server/Dockerfile`, and only required test harnesses.
- Transitional callers: bounded Rust ML URL wiring only; no Rust behavior rewrite or traffic cutover.
- Remove after green proof: `services/ml-inference/**` and its separate release-image entries.
- Operations/contracts: `docker-compose.yml`, release/smoke/load/verify scripts and tests, relevant
  living docs, umbrella impact map, and W2.17 evidence.

## Non-goals and rollback

- No new repository, backend package, broker, database migration, runtime dependency, model, metric,
  learner-feedback claim, public route, ASR replacement, realtime rewrite, or canonical data edit.
- No route-path collision: public platform `POST /v1/audio-chunks` remains realtime-ticket metadata;
  raw PCM `POST /v1/audio-chunks` exists only on the worker's private key-gated listener.
- During W2.18 rollback, Rust points at the same worker compatibility allowlist. The broad allowlist
  is removed only after measured Rust consumers are gone; gateway ingress remains until W3.

## Implementation ledger

- [x] T1 — red ownership guard, module/test relocation, byte/output parity. Local canonical proof:
  `VERIFY OK` on 2026-08-07; see `../evidence/W2.17-T1-inference-ownership.md`. Aggregate exact-SHA
  remote proof is recorded under T5.
- [x] T2 — local worker inference plus API wait-only durable boundary and cancellation proof. Local
  canonical proof: `VERIFY OK` on 2026-08-07; see
  `../evidence/W2.17-T2-local-worker-boundary.md`. Aggregate exact-SHA remote proof is recorded
  under T5.
- [x] T3 — worker compatibility ingress, direct storage/privacy/retention lifecycle and Rust proof.
  Local canonical proof: `VERIFY OK` on 2026-08-07; see
  `../evidence/W2.17-T3-audio-privacy-lifecycle.md`. Aggregate exact-SHA remote proof is recorded
  under T5.
- [x] T4 — one-image Compose/release/smoke migration and old ML tree removal. Local canonical
  proof: `VERIFY OK` on 2026-08-07; see `../evidence/W2.17-T4-one-image-cutover.md`. Aggregate
  exact-SHA remote proof is recorded under T5.
- [x] T5 — living docs, operational evidence, and complete local canonical gate. Local canonical
  proof: `VERIFY OK` on 2026-08-07; see `../evidence/W2.17-T5-operational-closure.md`. The refreshed
  core and acceptance suites, current canonical gate, and all four required exact-SHA remote checks
  are green.

The W2.17 engineering boundary is complete. Deployment canary, rollback, load/soak, and human
promotion evidence remain governed by W2.18 and are not claimed here. The generic
`scripts/update-ledger.sh T1 ...` command is intentionally not used because it rewrites every
unscoped `T1` row under `specs/*/tasks.md`; this feature-local ledger was updated only after its
exact canonical gate passed.

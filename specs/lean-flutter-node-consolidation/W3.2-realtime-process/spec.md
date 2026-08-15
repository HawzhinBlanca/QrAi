# W3.2 specification — isolated Node realtime process lifecycle

**Status:** approved under the owner-approved W0–W7 consolidation plan<br>
**Parent criteria:** BE-5, OP-4<br>
**Primary proof:** `tests/realtime/process-lifecycle.test.mjs`

## Scope

W3.2 creates the independently deployable Node realtime process shell from the existing `server`
package and production image. It owns process configuration, liveness, deep readiness, private
metrics, failure isolation, and bounded shutdown. It does not yet accept a WebSocket upgrade or
audio frame. Admission is W3.3, durable replay is W3.4, and the bounded audio runtime begins in
W3.5.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| RTP-1 | WHEN the realtime module is imported, THE system SHALL expose a testable composition seam without binding a port, and WHEN its entrypoint runs, IT SHALL bind only the configured realtime address from the same `server` package. | import-side-effect and real-child cases in `process-lifecycle.test.mjs` |
| RTP-2 | WHEN `/health`, `/ready`, or `/metrics` is requested, THE realtime process SHALL expose process-only liveness, dependency-aware readiness, and token-gated fixed-cardinality metrics respectively; every other HTTP path and every upgrade SHALL remain unavailable. | route/metrics/upgrade cases in `process-lifecycle.test.mjs` |
| RTP-3 | IF Postgres, private object storage, the job worker, or loaded-model ASR is unavailable or exceeds its bound, THEN `/ready` SHALL return only `503 not ready`, `/health` SHALL remain 200, failure counters SHALL identify only the closed dependency class, and no address, credential, tenant, learner, session, object key, or upstream error SHALL be returned or logged. | injected and real dependency-fault cases in `process-lifecycle.test.mjs`; no-secret guard |
| RTP-4 | WHEN SIGTERM or SIGINT arrives, THE process SHALL stop admission, report not-ready, drain bounded in-flight probe work, close storage and the database pool once, and exit inside the configured grace; IF an upgraded/raw socket or cleanup hangs, THEN the existing force and hard-deadline phases SHALL still bound exit. | real-child drain, raw-upgrade, close-order, and hard-deadline cases in `process-lifecycle.test.mjs` plus existing `graceful-shutdown.test.mjs` |
| RTP-5 | IF the API, worker, Rust gateway, or Node realtime process crashes or drains, THEN the other process roles SHALL remain independently alive; the Node realtime shadow SHALL publish no host port and SHALL receive no Web or gateway traffic before W3.9. | process-pair fault-isolation and parsed Compose topology cases in `process-lifecycle.test.mjs`; production-image contract |
| RTP-6 | WHEN the Node backend artifact is built, released, health-checked, or scraped, THE same immutable image SHALL contain API, worker, and realtime commands without a new package, image key, runtime dependency, or metrics label containing learner data. | package/image/release/monitoring contracts and canonical invocation guard |

## Non-goals

- No WebSocket implementation, ticket validation, Origin policy, replay record, queue, audio
  storage/index write, client change, or traffic switch.
- No Redis, NATS, service mesh, new framework, or new deployable image.
- No mutation of Quran data, learner-feedback behavior, authentication policy, migration, or RLS
  policy.

# W3.6 specification — durable storage/index outcomes

**Status:** approved for implementation under `plan.md`<br>
**Parent criteria:** RT-3, RT-4<br>
**Primary proof:** `tests/realtime/storage-index.test.mjs`,
`tests/e2e/teacher-audio-index.test.mjs`

## Scope

W3.6 joins the bounded Node realtime consumer to one shared, idempotent audio-index domain. It adds
durable tenant-scoped diagnostics for accepted audio that is lost or stored without an index,
preserves storage inventory as the outage-repair source, and records repair atomically with index
creation. Playback still requires `audio_chunks`; Rust remains the public realtime target.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| SIO-1 | WHEN a retained realtime chunk is stored successfully, THE Node consumer SHALL derive its identity only from frozen admitted claims and deterministic chunk metadata, SHALL create the `audio_chunks` row through the same domain authority as the HTTP route, and SHALL treat an exact retry as success while refusing changed immutable metadata. | shared-domain and live retained-index cases in `tests/realtime/storage-index.test.mjs`; `tests/api-parity/audio-index-parity.test.mjs` |
| SIO-2 | IF retained object storage succeeds but indexing fails or times out, THEN THE system SHALL preserve the readable object candidate, SHALL report `stored-unindexed` separately, SHALL durably record the degraded outcome whenever Postgres can accept it, and SHALL close the socket without advertising playback or recording completion. | index-conflict/outage/timeout/object-survival/socket-close/metrics cases in `tests/realtime/storage-index.test.mjs` |
| SIO-3 | IF a frame was acknowledged as enqueued but its object-store operation fails, aborts, or times out, THEN THE system SHALL idempotently record one `accepted-lost` diagnostic and add only newly observed unique losses to `recitation_sessions.lost_chunk_count` when Postgres is available; repair SHALL remove only the repaired loss so unrelated inference gaps survive; IF that record also cannot commit, THEN it SHALL emit a distinct fixed unrecorded-failure outcome and close the socket, never silently continue or claim completion. | store-failure/timeout/retry/dual-outage/session-aggregate/repair-delta cases in `tests/realtime/storage-index.test.mjs` |
| SIO-4 | WHEN a binary frame is rejected before enqueue, THE system SHALL report `rejected` separately, SHALL NOT create a durable accepted-chunk outcome, store/index bytes, consume sequence, or alter `lost_chunk_count`, and a later accepted retry SHALL retain the same deterministic identity. | empty/oversized/backpressure/retry outcome cases in `tests/realtime/storage-index.test.mjs` and `tests/realtime/backpressure.test.mjs` |
| SIO-5 | WHEN reconciliation inspects a stored candidate, THE repair authority SHALL independently verify tenant, session, learner, current session consent retention, safe span/rate, key, and byte/metadata integrity; dry-run SHALL write nothing, apply SHALL commit the index and repair timestamp together, and rerun SHALL neither duplicate nor increment repair. | ownership/retention/corruption/dry-run/apply/atomic/rerun cases in `tests/e2e/teacher-audio-index.test.mjs` |
| SIO-6 | WHEN a teacher reads recording state, THE system SHALL advertise `available` only from a tenant-scoped durable `audio_chunks` index whose retained object passes integrity and consent checks; a stored-unindexed object SHALL remain unavailable with actionable operator state, and successful repair SHALL make audited playback possible. | outage-before-playback/repair-after-playback and retention cases in `tests/e2e/teacher-audio-index.test.mjs`; playback parity regressions |
| SIO-7 | WHEN schema, metrics, topology, privacy deletion, and canonical verification are inspected, THE diagnostic table SHALL be additive, forced-RLS, session-cascaded, constrained and free of raw credentials/audio/errors; outcome labels SHALL be fixed; W3.6 proof SHALL run exactly once; and no package, broker, client, Rust traffic, Quran, model, or login boundary SHALL change. | migration/RLS/cascade/redaction tests; `tests/contract/verify-invocations.test.mjs`; realtime/topology/privacy regressions |

## Non-goals and stop conditions

- No claim of atomic S3+Postgres commit, exactly-once delivery, or client-visible completion ack.
- No reconnect/backoff/buffer/finalize redesign (W3.7/W4.11), codec/sample-rate wire change (W3.8),
  public traffic switch/canary, Rust removal, new service/package/broker, or second byte/index writer.
- No public review enum or Flutter/Web contract expansion in this slice. Stored-unindexed is an
  operator/runtime diagnostic; playback remains unavailable until repair commits the existing index.
- No canonical Quran, Arabic regex, AI feedback, evaluation/model, auth/login, or retention-policy
  vocabulary change. If implementation requires one, amend this plan and obtain renewed approval.

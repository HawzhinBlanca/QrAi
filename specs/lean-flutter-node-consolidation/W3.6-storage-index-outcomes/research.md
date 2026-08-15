# W3.6 storage/index outcomes — research
## Grounded current state

- Parent RT-3 forbids silent completion after socket/store/index failure; RT-4 requires retained
  objects to become durable indexes before playback, or an actionable degraded state.
- W3.5 accepts bounded FIFO audio and calls the create-only object store. Its ack means enqueued;
  `storeChunk` records process-local `stored|failed|aborted`, never indexes or durable loss.
- `createRealtimeApplication` already owns the restricted `db`; production uses a two-second
  server-side statement timeout and closes audio before replay/store/DB during shutdown.
- `routes/recitation.mjs::indexAudioChunk` is the Node index writer: signed claims determine
  tenant/session/learner/retention, the session and consent must agree, keys are derived, and an
  exact retry is idempotent. Only the route registry calls it.
- `audio_chunks` under forced RLS is the playback authority. `review.mjs::audioStatus` advertises
  `available` only when an overlapping row exists; an object alone is never playable.
- `repair-audio-index.mjs::repairAudioIndex/reconcileCandidate` inventories object metadata, checks
  tenant/session/learner, and dry-runs or inserts idempotently. It does not recheck current session
  retention and repair provenance exists only in one command summary.
- `recitation_sessions.lost_chunk_count` is filled only during finalization from inference-reported
  interior gaps. It cannot identify a lost tail and has no per-chunk idempotency authority.

## Failure model and decision inputs
- S3-compatible object storage and Postgres cannot share one transaction. A successful conditional
  object write is therefore the durable stored-unindexed recovery source; the database index cannot
  be claimed until its own transaction commits.
- AWS documents successful S3 PUT followed by GET/HEAD/LIST as strongly consistent and one-key
  atomic, matching the existing create-only object contract:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel
- PostgreSQL 18 documents RLS as default-deny once enabled and `FORCE ROW LEVEL SECURITY` as the
  owner-bypass control, matching every new tenant-owned diagnostic table:
  https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- A Postgres outage can prevent recording itself in Postgres. Keep the object candidate, a fixed
  runtime signal, and forced socket failure; do not invent cross-resource exactly-once/completion.
- Rejected frames do not consume sequence and may later succeed under the same deterministic chunk
  id. Persisting rejection as the chunk's current state would corrupt history; bounded fixed metrics
  are the correct rejection report, while accepted failures need per-chunk durable diagnostics.

## Smallest robust boundary
- Extract one storage-owned index domain for HTTP, realtime, and repair; keep `audio_chunks` as the
  only playback index and the object store as the only byte writer.
- Add one additive forced-RLS per-chunk diagnostic table. It records immutable span/rate plus initial
  `accepted-lost|stored-unindexed`, a fixed reason, and nullable repair time; session deletion
  cascades it. It stores no bytes, ticket, nonce, learner name, exception, or caller object key.
- On store failure, record accepted-lost idempotently and derive the session aggregate from unique
  rows; if Postgres is unavailable too, increment a distinct fixed unrecorded counter and close.
- On retained-object success, index idempotently. Index failure keeps the object, records the
  degraded state when Postgres permits, increments a fixed counter, and closes to stop orphan growth.
- `discard` audio follows its existing short retention lifecycle and is not advertised/indexed by
  realtime. Repair rechecks database tenant/learner/retention and atomically records repair with the
  index; dry-run and rerun remain side-effect-free/idempotent.

## Caller, proof, and parallel-work findings

- Direct integration surfaces are `realtime/{audio,main}.mjs`, `routes/recitation.mjs`, the repair
  command, migration/manifest collateral, playback regressions, and realtime fake authorities.
- Existing Rust gateway/index/playback tests remain the compatibility oracle; W3.6 adds Node-native
  storage/index/loss proof and extends the real retention/playback/repair E2E without moving traffic.
- Verification needs one dedicated live-Postgres W3.6 command plus an exact-one invocation guard.
- Research started at clean synchronized `05a4dd0`. A fetched parallel privacy branch changes audit
  export/erasure semantics, so W3.6 deliberately avoids audit-events as its outcome store and must
  re-fetch/reconcile before touching privacy documentation or deletion collateral.

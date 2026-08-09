# Architecture Decision Records

Short ADRs. Add one whenever you introduce a new runtime dependency or make an
architectural change. Newest first.

---

## ADR-0053 — Postgres is the Node realtime single-use authority

**Status:** Accepted · **Date:** 2026-08-08 · **Decider:** repository owner through the approved persistent implementation goal
**Related:** ADR-0051 (realtime contract), ADR-0052 (Node admission), ADR-0050 (one Node package)

### Context

ADR-0051 made Postgres replay protection conditional on a restricted-role cross-instance benchmark.
The Node shadow now needs one durable decision between valid ticket admission and WebSocket upgrade,
without persisting the raw ticket/nonce, trusting process memory, or adding Redis/NATS. The existing
`realtime_session_tickets` table is issuance/audit state keyed by a whole-token digest and is not a
single-use nonce authority.

### Decision

- Migration 0036 adds forced-RLS `realtime_ticket_replay_claims`, scoped by tenant, session, and the
  lowercase SHA-256 of the exact signed nonce bytes. It stores no raw credential and cascades with
  session privacy deletion. `numeric(20,0)` preserves the signed ticket's full u64 expiry domain.
- Admission performs one restricted `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` after
  Origin/ticket/rate validation and before `101`. The select independently verifies the visible
  tenant/session/learner and expiry against database time. Conflict or absent scope is generic 401;
  database error/timeout is bodyless 503. There is no memory fallback.
- Cleanup deletes at most 1,000 expired rows per pass in deterministic order with
  `FOR UPDATE SKIP LOCKED`. One unref'd interval owns scheduled cleanup, suppresses overlap, retains
  rows on failure, and is drained before the database pool closes. Metrics use fixed outcomes only.
- The approved restricted-role profile—32 warm-ups, 512 durable unique claims, concurrency 32 using
  two independent production-default pools—passed the p95 `<100 ms` and throughput `>=100/s` bars.
  Postgres is therefore selected for Node. Rust Redis/in-memory behavior remains the no-traffic
  compatibility oracle until later parity/canary/rollback gates permit retirement.

### Consequences

Two Node instances and fresh processes cannot accept the same signed session nonce. Accepted socket
context excludes the nonce, and accepted metrics advance only after durable success. W3.4 adds no
service, dependency, port, public route, client change, audio handling, or traffic movement. Reverting
the Node replay call returns the internal shadow to W3.3; the additive table may remain inert.

---

## ADR-0052 — Node realtime admits one internal shadow route with the Fastify adapter

**Status:** Accepted · **Date:** 2026-08-08 · **Decider:** repository owner through the approved persistent implementation goal
**Related:** ADR-0051 (realtime contract), ADR-0050 (one Node package), ADR-0022 (reversible release)

### Context

W3.2 established an independently drainable internal Node realtime process, but deliberately
refused every upgrade. W3.3 needs a real authenticated handshake for ticket/Origin/rate parity
without creating a second package, hand-written WebSocket stack, public route, replay claim, or
audio implementation. Node's platform library is a client, not a production WebSocket server.

### Decision

- `@fastify/websocket` 11.3.0 is the one supported server adapter and an exact production
  dependency of the existing `server` package. Its transitive `ws` version stays frozen by the
  workspace lockfile; there is no second direct socket package or image.
- The adapter is registered before all routes. Only the exact session-audio route may upgrade.
  Admission reuses the established `rt_v2` validator and bounded token bucket, applies exact
  browser Origin and explicit native no-Origin policies, validates tenant and a maximum 3,600
  second remaining lifetime, and derives peer identity only through a bounded trusted-hop policy.
- A valid shadow upgrade receives `101`, passes only frozen claims plus nullable trace to the
  socket seam, and immediately closes code 1013 as temporarily unavailable. It reads, stores,
  forwards, and acknowledges no audio. Refusals remain generic HTTP classes and metrics expose
  only the four fixed admission outcomes.
- The process remains internal with no host port or public traffic. The Rust gateway remains the
  traffic target and compatibility oracle. W3.4 owns replay and its Postgres benchmark; W3.5 owns
  bounded audio, queues, and acknowledgements. Neither is implied by an admitted handshake.

### Consequences

This change proves a real, fail-closed Node admission shadow while leaving clients, public routing,
stored data, the Rust data plane, and rollback unchanged. Removing the plugin route and dependency
restores the W3.2 refusal-only shell. Traffic movement still requires the later parity, load,
canary, rollback, and human release gates.

**W3.5 implementation note (2026-08-09):** the historical W3.3 default above remains the admission
proof and an explicit test seam, but the production default now runs one bounded audio runtime. It
accepts at most 2 MiB of application bytes behind a 2 MiB + 64 KiB transport ceiling, retains at
most 8 chunks/4 MiB per session and 64 MiB process-wide, and permits 100 active/draining sessions.
`accepted=true` means enqueued, not stored; create-only object-store success/failure is a separate
fixed metric outcome. At the W3.5 milestone Rust remained the traffic target while W3.6 durable
outcome/index repair and later recovery, codec/rate, image, and canary gates remained open.

**W3.6 implementation note (2026-08-09):** the production shadow now sends every accepted store
result through one shared audio-index/outcome authority. Retained success creates the sole playback
index (`audio_chunks`) with the same current-session, learner, retention, derived-key, span/rate,
retry, and immutable-conflict rules as the HTTP adapter. Migration 0037 keeps only constrained
accepted-lost/stored-unindexed diagnostics under forced RLS and session cascade. Store/index failure
closes the socket and has a fixed outcome; finalization unions unrepaired accepted losses with
inference gaps. Repair revalidates object metadata against current tenant state and atomically
creates the index plus repaired provenance. A remotely committed conditional write discovered
after a timeout may therefore repair an initially accepted-lost chunk. Playback never consults the
diagnostic table. Rust remains the traffic target; W3.7 recovery and later image/canary gates remain
open.

---

## ADR-0051 — Realtime keeps one wire contract and gains an isolated Node entrypoint

**Status:** Accepted · **Date:** 2026-08-08 · **Decider:** repository owner through the approved persistent implementation goal
**Related:** ADR-0050 (one Node package), ADR-0040 (migration boundary), ADR-0022 (reversible release)

### Context

The Rust gateway currently owns WebSocket admission, replay checks, bounded audio ingress, and
`audio.ack`. The Node API already issues byte-compatible `rt_v2` tickets, but the shared ticket
vectors live under a transitional port spec and no language-neutral fixture pins acknowledgments.
Writing a Node socket before freezing those boundaries would allow two implementations to agree in
tests while disagreeing on the deployed wire or on which failures are security decisions.

ADR-0050 selected one modular Node codebase with separate process roles. It also said Postgres owns
durable realtime replay state. This ADR qualifies that realtime clause: Postgres is the proposed
authority, not an implemented fact, until the W3.4 concurrency and load benchmark proves it meets
the admission budget. Device credential replay state remains Postgres-owned and is unaffected.

### Decision

- The same `server` package gains a separate realtime process and entrypoint. It must be
  independently deployable, drainable, observable, and failure-isolated from API and worker event
  loops. The Rust gateway remains the compatibility oracle until parity, load, canary, and rollback
  evidence permits retirement.
- The deployed wire stays unchanged. `rt_v2` tickets and `audio.ack` documents live in one
  language-neutral fixture root under `packages/contracts`. Rust remains the fixture generator and
  oracle. The raw ticket is never stored or persisted. Valid tickets preserve exact field order,
  UTF-8 HMAC bytes, boolean text, retention, unsigned-64-bit expiry, and lowercase signature.
- Replay identity is a SHA-256 nonce hash scoped to the signed claims. Postgres with a unique claim
  and TTL cleanup is the proposed shared replay authority, subject to the W3.4 benchmark. A
  configured shared authority fails closed when unavailable. The existing Rust Redis/in-memory path
  remains only as the compatibility oracle during that benchmark; this decision does not add Redis,
  NATS, a service mesh, or another runtime dependency.
- Browser upgrades require the exact configured Origin allowlist. A native client's no-Origin
  request is a separate, explicit deployment policy; it is never inferred from browser behavior and
  does not relax tenant, session, expiry, retention, signature, replay, or admission checks.
- Each session has a bounded per-session queue with explicit `audio.ack` responses. Consumers branch
  only on `kind` and `accepted`. `message` is non-empty diagnostic prose, not a semantic enum;
  `trace_id` is always present as a non-empty string or null. Sequence values must cross the JSON
  boundary as non-negative safe integers.

### Consequences

W3.1 freezes decision and fixture truth only. It adds no WebSocket listener, database migration,
replay store, queue, or traffic movement. W3.2 owns the process lifecycle; W3.3 owns admission;
W3.4 owns durable replay and the Postgres benchmark; W3.5 owns the bounded audio runtime. A failed
fixture change restores one authority rather than introducing a second copy.

**Implementation note (2026-08-08, W3.2–W3.4):** the existing `server` package/image runs an
internal `node-realtime` process alongside API and worker. It exposes process liveness, bounded
deep readiness, private fixed-cardinality metrics, and the exact admitted-but-unavailable shadow
route defined by ADR-0052. ADR-0053's restricted Postgres authority now makes valid tickets
single-use across instances/processes before upgrade. It uses the same restricted Postgres,
private object-store, shutdown, healthcheck, release, and rollback boundaries. It has no host port
or traffic edge; Rust remains the only realtime ingress.

**W3.5 implementation note (2026-08-09):** the same process now enforces a 2 MiB application and
2 MiB + 64 KiB transport boundary, 8 chunks/4 MiB per session, 64 MiB process-wide, and 100
active/draining sessions. `accepted=true` means enqueued, not stored; a bounded FIFO writes through
the existing create-only object-store interface and reports storage separately. Shutdown drains or
aborts before resource close. Rust remains the traffic target until recovery, durable outcome,
format, image, canary, and rollback gates pass.

**W3.6 implementation note (2026-08-09):** the bounded consumer now reports fixed indexed,
discarded, stored-unindexed, accepted-lost, unrecorded-dependency, and rejected outcomes. Retained
success and the signed-ticket HTTP adapter share one current-session/retention/index domain;
migration 0037 records only privacy-safe forced-RLS diagnostics, while `audio_chunks` remains the
sole playback authority. Store/index failure closes the socket, finalization preserves unique
unrepaired accepted losses, and the dry-run-first repair command atomically indexes and marks a
verified retained object repaired. Rust still receives all public realtime traffic; recovery,
format, image, canary, and rollback gates remain open.

---

## ADR-0050 — One modular Node backend owns runtime, deadlines, storage, and production identity

**Status:** Accepted · **Date:** 2026-08-07 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0040 (migration boundary), ADR-0038 (controlled device enrollment), ADR-0028 (learner gate)

### Context

`services/node-api` is a well-tested strangler, but it is not a deployable product boundary. Its
runtime imports are declared as root development tooling, it still falls back to Rust, retained
audio is filesystem-backed, several dependencies can wait forever, and lifecycle/security parity
is incomplete. Moving files without first settling these boundaries would create a smaller tree
whose failure and identity semantics were accidental.

The approved destination is one Node codebase, not one overloaded event loop. Postgres and private
object storage are infrastructure. Python ASR remains an isolated evaluated worker until an
alternative passes the same evidence gates.

### Decision

- `server/package.json` is the one production dependency boundary. It exposes independently
  deployable and independently drainable API, realtime, and worker entrypoints. CPU-heavy
  inference and background work never run on the API event loop. These process roles share domain
  modules and contracts; they are not separate application services or dependency trees.
- Every runtime import is declared in `server/package.json` under `dependencies` and is present in
  the frozen workspace lock. The root package remains orchestration/test tooling only. Fastify,
  Postgres, JOSE, validation, and contract parsers move with their callers. The production object
  adapter uses `@aws-sdk/client-s3`; native `AbortController`, Web Crypto, and platform APIs are
  preferred where they already provide the required behavior. A later dependency still requires
  its own reviewed diff.
- Production retained audio uses private S3-compatible object storage. The filesystem adapter is
  test/development only. Object keys are constructed from server-derived tenant, learner, session,
  and chunk identities; bucket credentials and raw object locations never cross the API boundary.
  Postgres remains authoritative for the tenant-bound audio index, retention state, outbox work,
  and privacy lifecycle.
- Each request receives one monotonic deadline. Every Postgres, object-storage, ASR, compatibility,
  and worker operation consumes the remaining budget and receives an `AbortSignal`; child work may
  shorten but never reset the parent deadline. No durable operation may claim complete after
  cancellation. Retried effects require an idempotency key or transactional outbox record, and
  timeout responses reveal no dependency internals.
- Volumetric HTTP/WebSocket admission uses bounded per-process token buckets with explicit capacity,
  refill, cardinality, and eviction limits. Client network identity is derived only through
  configured trusted-proxy hops. Rate limiting is defense in depth, never authorization. Postgres
  owns durable credential attempt and replay state for enrollment, refresh, and realtime-ticket
  boundaries so another instance cannot reset a security decision. The lean target adds no Redis
  or NATS.
- Production identity follows ADR-0038: login remains owner-gated off; a single-use invitation is
  exchanged for a rotating, revocable, expiring device session with server-derived tenant and role.
  Raw invitation, access, and refresh material uses hash-only credential storage and is never
  logged. Staff roles are provisioned by authorized administration and are never caller-selected.

### Consequences

W2.2 may now create the package without inventing architecture in code. Later W2 tasks must prove
standalone lifecycle, middleware order, restricted-role boot, deadlines/cancellation, storage
lifecycle, and enrollment before traffic moves. This ADR neither activates new routes nor claims
that filesystem audio, the Rust fallback, or debug identity is production-ready.

**Implementation note (2026-08-07, W2.9):** the package now defaults to standalone when no upstream
is configured, registers every key from one executable route registry, and has no proxy catch-all.
The Rust fallback survives only in explicitly configured compatibility mode for parity/canary
reversal. Compose remains that compatibility shadow, so this source-mode change is not a traffic
cutover or a production-readiness claim.

**Implementation note (2026-08-07, W2.10):** the Node HTTP boundary now applies literal/exact CORS,
maintenance, bounded per-process token-bucket admission, request parsing/body ceilings,
authorization/handlers, fixed error redaction, and response metrics in one tested order. Admission
is default-on at a 200 burst and one token per 50 ms, with 10,000-key/idle-LRU bounds and no new
broker or dependency. Forwarded client identity remains ignored unless proxy trust is explicitly
enabled with a positive bounded hop count. This completes HTTP admission behavior, not W2.12
dependency deadlines, W2.13 drain, W2.16 durable credential-attempt state, or W3 realtime limits.

**Implementation note (2026-08-07, W2.11):** the Node database pool now inspects its effective
Postgres role during Fastify `onReady`, before a listening socket can be established, and refuses
`SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, or `REPLICATION`. The established
`ALLOW_SUPERUSER_DB_ROLE`/deprecated local alias remains the only explicit development relaxation.
All ordinary tenant work stays behind the transaction-local `withTenant` boundary. Pilot invitation
bootstrap now uses `withDiscoveredTenant`: its locked-down security-definer lookup runs first, then
the shared tenant GUC and statement timeout are installed before tenant-owned work can run. A static
gate pins database-driver ownership and the exact tenant-neutral/security-definer raw SQL allowlist.

**Implementation note (2026-08-07, W2.12):** every API request now receives one monotonic deadline
before maintenance/admission/authorization or database work. The same signal reaches compatibility
forwarding, ML/ASR proxying, finalization, privacy erase, review audio, ML→ASR windows, and agent
platform calls; caller disconnect also aborts it. The shared helper uses only Node platform APIs.
Postgres connections install server-side `statement_timeout` and
`idle_in_transaction_session_timeout`; tenant transactions tighten the statement limit to the
request remainder. This deliberately avoids a JavaScript promise race that could answer timeout
while a transaction later commits. SQLSTATE `57014` is a fixed retryable 503, while dependency
boundaries use fixed 502/503 responses without URL, token, transcript, audio, or driver detail.
Review audio keeps its pre-fetch attempt audit but records `delivery: served` only after a complete
valid response. `tests/faults/dependency-timeouts.test.mjs` proves hung partial-response socket
cancellation for compatibility, ASR, storage/privacy/review, and workers plus live Postgres rollback.
This completes W2.12 cancellation semantics, not W2.13 drain, W2.15 outbox retries, or W2.17 final
storage/worker relocation.

**Implementation note (2026-08-07, W2.13):** the Node API now installs one dependency-free
SIGINT/SIGTERM controller before listen. The first signal invokes Fastify close, immediately closes
admission, preserves active HTTP responses, and reserves the final fifth of a strict 1–300 second
budget for `onClose` resources. Remaining HTTP/raw/upgraded sockets are force-closed at the reserve
boundary; a second signal escalates the same shutdown, and a hard outer timer exits non-zero rather
than hanging indefinitely. The Postgres.js pool consumes only the reserved close time and successful
completion is logged after `sql.end`. Pinned Fastify 5.11's native close branch treats documented
`forceCloseConnections: "idle"` as truthy and drops active requests, so the app explicitly uses
`false`: Node 22 `server.close()` reaps idle sockets and the controller alone owns timed active
closure. The production image declares SIGTERM and Compose gives the eight-second app budget a
ten-second container stop window. This completes HTTP/process drain; W3 still owns protocol-level
WebSocket close frames for the future Node realtime entrypoint.

**Implementation note (2026-08-07, W2.14 dependency):** the production S3 data-plane adapter uses
exact `@aws-sdk/client-s3` 3.1101.0 (Apache-2.0, Node >=20), the newest registry release older than
the repository's dependency-age window when selected. The newer 3.1102–3.1105 releases were not
taken hours after publication. The modular v3 client supplies maintained Signature V4,
S3-compatible endpoint/path-style configuration, conditional commands, checksum fields, response
stream handling, SDK retry classification, and AbortSignal propagation; reimplementing signing and
XML error semantics with raw `fetch` would add security-critical code rather than make the system
leaner. The adapter imports only `@aws-sdk/client-s3`, never a browser upload or presigning package.
No bucket credential, raw object URL, or caller-authored key crosses the API boundary.

**Implementation note (2026-08-07, W2.14 lifecycle):** one shared async store now serves the Node
API and worker-owned inference runtime. Production refuses an implicit driver and refuses filesystem unless
the conspicuous development-only acknowledgement is set. S3 writes are private conditional creates
with full SHA-256 checksums and bound identity/retention/span metadata; reads consume and validate the
complete body; lists paginate; deletes inspect per-key errors and verify the learner prefix is empty.
Every command receives the request `AbortSignal`, readiness checks the bucket, and shutdown destroys
the client. Filesystem uses create-only owner-private files and retains an explicit legacy reader for
migration tests/development, never as a silent production fallback.

Object keys are derived from verified tenant, learner, session, and chunk identity in both Node and
the Rust compatibility oracle. Identical byte/metadata retries are no-ops; changed immutable data or
index metadata returns a conflict. Review playback and privacy export/delete use the injected store
directly; the temporary private HTTP seam is limited to measured Rust/gateway compatibility
consumers and uses the worker's exact store instance. The storage/index boundary is not falsely
described as atomic: inventory
exposes incomplete pairs, and `repair-audio-index.mjs` is storage-neutral, dry-run first, idempotent,
ownership-checked, and reports inverse index-without-object states. Production bucket provisioning,
credential rotation, monitoring, and restore rehearsal remain deployment work, not application claims.

**Implementation note (2026-08-07, W2.15):** one forced-RLS Postgres `background_jobs` table is the
durable queue and transactional outbox for session finalization, session Tajweed evaluation, and
privacy export/delete. No Redis, NATS, queue ORM, second backend package, public job route, or
privileged queue role was added. API callers still receive the existing synchronous response body:
the API enqueues and waits within its request deadline, while the same-package `job-worker` owns
first execution, expired-lease recovery, and retries. Claims use `SKIP LOCKED`, bounded
leases/attempts, monotonic generations, fixed
error codes, and capped backoff. External inference and object deletion are at-least-once; only the
fenced tenant transaction containing the domain effect and job completion is exactly-once.

Privacy now commits a bounded identifier/object manifest before its idempotent erase, closing the
crash window without putting audio, transcripts, credentials, or dependency addresses in the queue.
The worker reads only the global institution registry, then claims and commits under ordinary tenant
RLS. Its private health/readiness/metrics endpoint has finite state/kind/outcome labels, and SIGTERM
stops claims, cancels work, then closes storage and Postgres within the configured grace. A dead row
is never reset: an in-tenant admin/ops recovery command creates one audited, idempotent successor;
if that successor dies, it is the next immutable replay source. Runtime session evaluation may only
read existing release evidence. The offline evaluator and detached signature/release checks remain
the sole evidence authorities; the job package cannot write `eval_runs` or access signing material.
Local live-Postgres proof does not substitute for required remote CI and staging recovery drills.

**Implementation note (2026-08-07, W2.17):** alignment, instructional Tajweed, transcript assembly,
acoustic-shadow observation, retained-audio handling, and privacy inference now live under
`server/src/inference`; the former standalone ML source tree, Compose service, and OCI image are
removed. At W2.17, `node-api` and `job-worker` became different commands of the exact same
production image; W3.2 later adds `node-realtime` as a third command of that image without moving
traffic.
The API never executes durable work inline: it enqueues and waits, while the worker is the sole
owner of first attempts, retries, and crash recovery. The worker injects one exact object-store
instance into both workflow and inference paths, preventing adapter drift.

The worker's port 8098 listener is a temporary private compatibility boundary for the measured
Rust platform/gateway consumers. It is constrained by a service key, closed route allowlist,
bounded admission/body sizes, and monotonic deadlines; it is not a second application or public
API. Compose, release inventories, smoke tests, and Docker CI require one Node image identity. The
Python ASR model process remains isolated. This cutover consolidates Node inference ownership; it
does not silently move public HTTP or realtime traffic, which retain their independent canary and
rollback gates. Required remote CI, staging replay, and production infrastructure proof remain
outside the local implementation claim.

**Implementation note (2026-08-07, W2.18):** base Compose remains Rust-safe. The explicit
`docker-compose.canary.yml` overlay starts Node in a closed `retained-canary` mode whose exactly 39
retained routes are derived from the checked route manifest, then moves Web requests and realtime
indexing to Node together. Rust remains live for the four retirement-transition operations and for
immediate reversal. The upstream selector accepts only the internal Rust or Node service address;
missing, URL-shaped, or arbitrary hosts fail Web startup.

This is one isolated environment/cohort switch, with no random traffic split or dual write. A
mutable retained request executes locally once; transition routes proxy once to Rust. Applying the
canary overlay is therefore an explicit deployment decision, and removing it returns Web and the
gateway to the base Rust targets. Candidate and previous application bits are independently bound
to immutable GHCR digests by ADR-0022. The topology and effect guards do not claim that a candidate
was deployed, observed, approved, or rolled back within an SLO; those remain W2.18 operational
evidence gates.

**Implementation note (2026-08-08, W2.18 T3):** retained-canary mode alone emits a bounded
`x-qrai-route-owner` marker so an image probe can distinguish local Node handling from the Rust
compatibility path without changing ordinary responses. The candidate proof consumes only the
release overlay's immutable digests, verifies actual container image IDs and running selector
values, uses short-lived JWT actors, and writes expiring evidence once. It deliberately stops and
restores Rust to prove the 39 retained routes have no silent fallback. This mechanism does not make
a promotion decision and does not replace load, monitoring, rollback, remote CI, or human gates.

---

## ADR-0049 — Release claims require signed row-level evaluation evidence

**Status:** Accepted · **Date:** 2026-08-07 · **Decider:** repository owner through the approved W1.11–W1.13 plan
**Related:** ADR-0048 (acoustic shadow boundary), ADR-0045 (immutable candidates), ADR-0043 (producer attribution)

### Context

The existing evaluation route copied aggregate accuracy numbers from a committed golden fixture.
The database and release checker could compare those numbers with thresholds, but neither could
prove which model bytes, corpus split, evaluator, raw rows, or calibrator produced them. A boolean
`passed`, an aggregate-only document, or a filename containing “golden” is not evaluation evidence.
The repository currently has no consented and adjudicated Kurdish-L1 held-out corpus, no approved
calibrator, and no release-eligible acoustic evidence.

### Decision

- `model-evaluation-evidence-v1.schema.json` is the one strict JSON Schema 2020-12 contract for
  computed evaluation bundles. Unknown fields fail; mutable aliases and aggregate-only input are
  insufficient. Every bundle binds the candidate artifact and implementation, registry/runtime/image,
  sealed dataset and reciter-disjoint split manifests, evaluator source and approved protocol, raw
  row manifest/results, counts, subgroup slices, calibration, uncertainty, approvals, and timestamps.
- Evidence is computed from immutable row-level labels and scores. Metrics include average precision,
  ROC AUC, the selected operating point, calibration error, agreement, and reciter-clustered bootstrap
  intervals. Caller-supplied summaries never become the source of those values.
- The evidence object is canonicalized with RFC 8785. A separate envelope carries a detached Ed25519
  signature, signer key id, and the SHA-256 of those exact canonical bytes. Trust class belongs to
  operator-controlled public-key policy, not to a self-asserted field in the signed bundle.
- Eligibility is closed: `fixture-regression`, `research-only`, or `release-candidate`. A release
  candidate additionally requires a runnable license-approved artifact, consented licensed sealed
  held-out data, reciter-disjoint split, approved protocol, bound calibrator, and all four external
  approvals. Signature verification and release policy still decide whether it may clear a gate.
- Fixture and test-key bundles can exercise the machinery, but can never qualify as calibration or
  release authority. Production trust contains public keys only; no private signing material belongs
  in the repository.
- Runtime calibration has a separate closed registry. Its active record must name byte-verified
  calibrator data and exactly match the acoustic scorer artifact, evaluated dataset manifest, and
  verified evaluation-evidence digests. The committed registry is empty; the current shadow
  candidate refuses active calibration, so adding a file or changing an alias cannot publish a
  confidence without a separately reviewed candidate promotion.
- Every new acoustic finding persists the exact model artifact, dataset manifest, calibrator, and
  evaluation evidence identities. Learner readback additionally derives its alignment span and
  retained-audio evidence from server-owned rows. The learner gate requires all of them, a valid
  citation, human approval, calibrated confidence, release-trusted evidence, and an audit id.
- Gate status is derived at the platform boundary. Inference callers cannot self-assert
  `release-trusted` or `calibrated`; stale, fixture, unverified, missing-audio and historical rows
  remain available to staff while their learner-facing judgment fields are redacted.

### Consequences

Evaluation becomes an auditable supply chain rather than a row of plausible decimals. Schema-valid
does not mean trusted, accurate, or releasable. The implemented release checker re-hashes bytes,
verifies the detached signature, binds every database identity/count/slice/calibrator projection,
and requires one unique authority across all tenant-visible history. Newer rows cannot hide older
ones; invalid or distinct release-labelled evidence fails closed. Because production trust is empty,
migration 0032 demotes the remaining aggregate `eval-passed` claim. Until external data and
approvals exist, W1.10 stays shadow-only and learner findings stay empty.

---

## ADR-0048 — Muaalem v3.2 is an internal acoustic shadow candidate, not learner feedback

**Status:** Accepted · **Date:** 2026-08-07 · **Decider:** repository owner through the approved W1.10 plan
**Related:** ADR-0047 (instruction/performance boundary), ADR-0045 (immutable candidates), ADR-0043 (producer attribution)

### Context

The retired ASR Tajweed endpoint inferred rule presence from duration, pitch variation, energy, and
spectral centroid. Those features were not reference-aware error detection, had no calibrated
decision boundary, and could not justify a learner claim. A second standalone experiment duplicated
the Python/model boundary without a production caller and has now been removed. The selected upstream
Muaalem v3.2 checkpoint is reference-aware and predicts phonemes/sifat, but its model card leaves
training/evaluation detail incomplete and upstream explicitly describes its softmax values as
uncalibrated. Its published results are not Kurdish-L1 child evidence.

### Decision

- One immutable shadow candidate is recorded in `acoustic-candidates.json`: Hub revision
  `01a1ef9fbe40d144ef845101e89ff924aed3fef5`, safetensors SHA-256
  `6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41`, implementation commit
  `2e444e040516781ecef72fe9bbc513bb34dedad4`, and QPS commit
  `fb64a1a8b0d7f5c38ffe26de0c69cc4a2b840950`. Every required local model file is independently
  size- and digest-pinned.
- The ordinary ASR image remains lean and unchanged. An explicit `acoustic-candidate` Docker target
  installs the source locks, embeds the model, verifies all bytes at build time, and runs offline.
- Muaalem runs only behind the existing ASR process in a bounded restartable child. The private
  route accepts 16 kHz mono windows no longer than 15 seconds and only server-derived measured word
  spans. The public proxies reject caller-authored learner identity, Quran identity, and spans.
- QPS is derived directly from the server-authoritative canonical bytes with the versioned
  scholar-pending Hafs/murattal 4/4/4/4 profile. The adapter never uses upstream Aya/Tanzil lookup,
  `normalize_aya`, or Unicode normalization.
- Exact-image inference found that the pinned upstream sifat mismatch branch assigns aligned class
  ids into its probability vector; observed `SingleUnit.prob` values therefore reached `2.0`.
  Categorical sifat label/index observations remain available internally, but every sifat score is
  explicitly marked `withheld-upstream-decoder-bug`. Separately range-validated phoneme softmax
  values remain ephemeral shadow observations.
- No shadow value is renamed `confidence`, persisted, placed in `findings[]`, reviewed as learner
  performance, or returned to Flutter. Audit metadata retains only bounded
  status/count/attribution/refusal information.

### Consequences

The repository has one credible acoustic research path instead of two disconnected services, but
it still has no release-grade acoustic finding. The reproducible correct/muted vector pair proves
only structural execution and sensitivity; it is not an error-detection or accuracy result.
Promotion requires an upstream fix or independently verified sifat decoder, independent model/data
licence review, scholar approval of the QPS profile, a consented adjudicated Kurdish-L1 held-out
corpus, calibration, reciter-disjoint evaluation, latency/memory evidence, and candidate-bound
approval. Until every gate is proven, `releaseEligible=false` and learner `findings[]` remains empty.

---

## ADR-0047 — Tajweed instruction is not learner-performance evidence

**Status:** Accepted · **Date:** 2026-08-07 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0033 (analysis basis), ADR-0036 (placeholder confidence), ADR-0043 (producer attribution)

### Context

The deterministic Tajweed engine reads canonical Quran text only. It does not listen to the learner,
measure a recitation span, or calibrate an acoustic score. Despite that, its rule occurrences and
golden-fixture decimals travelled as performance-shaped `findings`, were persisted in
`tajweed_findings`, entered the teacher performance queue, and could be accepted as feedback about a
learner. Replacing invented decimals with zero did not fix the category error: zero was still a
claimed performance confidence for something never measured.

### Decision

- Tajweed prediction has two disjoint arrays. `annotations[]` contains deterministic canonical
  instruction with `analysisBasis='text-rule'`, `instructional=true`, sources, and no confidence,
  severity, or review state. `findings[]` is reserved for span-linked acoustic learner judgments and
  remains empty until a calibrated, evaluated, and approved acoustic candidate is promoted.
- Declared golden-fixture rules follow the same annotation contract; fixture decimals and severity
  never cross into learner-performance output.
- Rust and Node validate the separation before persistence or response redaction. Cross-contaminated
  shapes fail with a generic upstream 502. Persistence accepts only explicit acoustic findings and
  writes the acoustic basis as a server literal.
- Migration 0030 reclassifies historical `canonical-text` rows to `text-rule`, nulls their placeholder
  confidence, and enforces `text-rule/null` versus `acoustic/non-null` consistency. The rows remain
  available for audit; performance queues, learner session reads, and accepted teacher reviews
  exclude them.
- Flutter parses only acoustic findings and fails closed on a missing or non-acoustic basis. It may
  ignore instructional annotations until a dedicated teaching surface exists, but it cannot render
  one as a recitation error.

### Consequences

The product can teach where a Tajweed rule applies without pretending it detected a learner mistake.
Historical audit data is retained without remaining actionable performance feedback. A real learner
finding now requires an acoustic producer; this decision does not implement or validate that producer,
calibrate confidence, or make any accuracy claim. ADR-0033 and ADR-0036 remain historical context but
their temporary `canonical-text` performance-row behavior is superseded by this decision.

---

## ADR-0046 — Finalized words link to one exact tenant-bound producer run

**Status:** Accepted · **Date:** 2026-08-07 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0043 (producer attribution), ADR-0040 (migration boundary), ADR-0030 (transcript source)

### Context

Component attribution existed on inference responses but disappeared before persistence. Bounded
transcription did not return its ASR/forced-aligner records, finalization forwarded token spans
without their author, and `word_alignments` had no run link. Joining the existing `alignment_runs`
table by session would be unsafe: a later client re-record can replace the words while an earlier
server run remains. New sessions also selected the historical `model-v0.3` registry row even though
the running producer identifies itself as `quran-constrained-levenshtein@1`.

### Decision

- Repeated bounded-window component records must be structurally identical and are stored once.
  Forced alignment augments ASR; Quran alignment must preserve that exact upstream document and add
  exactly one Quran-aligner record. Missing, conflicting, or unrelated attribution fails closed.
- The transcript attribution field exists only on the private finalizer-to-ML request. Both public
  APIs reject client-supplied spans and the attribution that would make those spans appear trusted.
- Migration 0029 adds an explicit, unique runtime-selected alignment registry row. Historical
  sessions are never rewritten; a session/producer compatibility-label disagreement refuses
  finalization and writes neither words nor a run.
- One successful finalization inserts one `alignment_runs` document and links every persisted word
  to it inside the same tenant transaction. The foreign key contains run id, tenant id, and session
  id. A `NOT VALID` check requires the link for new server-derived rows while retaining historical
  rows without inventing provenance.
- Staff-only alignment readback returns the stored compatibility model, transcript source, exact
  component document, dataset, evidence ids, and audit id. Legacy/client rows return null
  attribution/dataset and empty evidence ids. No default producer is substituted.

### Consequences

A word can now be traced from the exact inference response through Postgres and restricted readback,
and a client re-record deletes the obsolete run after its linked words. Sessions opened before the
runtime registry change may require a new recording rather than being relabeled. This proves
identity and lineage only; it does not make the captured audio an accuracy benchmark or select an
ASR winner. The Node finalizer remains W2.6; its absence is explicit in the parity coverage ledger.

---

## ADR-0045 — ASR candidates are immutable; no benchmark means no winner

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0044 (ASR readiness), ADR-0043 (producer attribution), ADR-0038 (lean target)

### Context

Readiness proved that the configured checkpoint loads and executes, but it did not prove that the
checkpoint is accurate for Kurdish-L1 Quran recitation. Compose ran generic Whisper `base`; the
Python default named a Hugging Face repository without a commit. A declared digest beside a mutable
repository alias still could not prove which snapshot produced a result.

The repository has no tracked evaluation audio and no approved, consented, reciter-disjoint
Kurdish held-out corpus. The strongest public Quran-pronunciation benchmark found, IqraEval 2025,
uses 18 Arabic-L1 adult speakers and elicited errors; it explicitly lacks children and broader
dialect coverage. It cannot substitute for the approved Sorani/Badini, age, device, and noise
slices. Tarteel's public model has an immutable artifact, but its model card does not disclose the
training/evaluation datasets needed to treat its WER as this product's evidence.

### Decision

- `services/asr-inference/model-candidates.json` is the single checked-in candidate registry. A
  runnable process names `ASR_CANDIDATE_ID`, and runtime/model/revision/artifact identity must match
  that record before model allocation.
- A Hugging Face candidate requires a full 40-character lowercase commit revision. The loader passes
  that revision to both download and pipeline construction, hashes the downloaded primary weight
  file, and refuses a mismatch. `main`, `latest`, branches, and unqualified repository aliases fail.
- The registry records generic Whisper `base` as the runnable baseline and Tarteel at commit
  `e3f4a5f3f5336a1f0e43a2c2bdae62a680c53a8c` with the upstream weight SHA-256. Tarteel remains
  `packaging-required`; neither candidate is selected.
- Candidate evidence must bind the registry identity, runtime lock, image, sealed held-out dataset,
  evaluator implementation, source commit, approved protocol, complete required slice matrix,
  aggregate metrics, per-slice metrics, and resource measurements. Thresholds come from the approved
  protocol, never constants introduced by the validator.
- A declared fixture may exercise the validator but is always ineligible. The registry status stays
  `blocked-no-eligible-benchmark` until the human approvals and real corpus exist. W1.12 owns metric
  recomputation and signed release evidence; this decision does not counterfeit either.

### Consequences

Generic aliases and copied metrics can no longer enter the ASR selection path. The current image
remains operationally useful but cannot be described as a reviewed winner, and learner-performance
feedback remains withheld. Completing W1.5 now requires external consented data collection and
independent owner, scholar, privacy/legal, data, and license review—not another code-only fixture.

---

## ADR-0044 — ASR liveness is process-only; readiness is model-and-probe gated

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0043 (producer attribution), ADR-0038 (lean target)

### Context

The ASR process loaded its model synchronously before FastAPI existed, so a hung load prevented
liveness from answering. A caught load failure later bound the port, but `/health` still returned
200 and Compose treated the degraded container as healthy. The response embedded `loaded` and an
exception string, yet no route or orchestrator gate proved that the selected artifact was the one
configured or that inference could execute.

### Decision

- `/health` is a fast process-only signal. Model loading, attribution validation, and inference
  never affect its status or expose their exception text there.
- One background controller owns load, validation, and retry. `/ready` and ASR-backed route
  admission read the same immutable snapshot; no readiness request runs inference.
- `ASR_MODEL_DIGEST` is mandatory. The current Compose-selected Whisper `base` artifact is pinned
  to the SHA-256 in Whisper's verified checkpoint URL, and a missing, malformed, unresolved, or
  mismatched digest fails closed. Configuration failures are terminal for that process rather than
  triggering a model reload storm.
- A deterministic 100 ms, 16 kHz mono zero-signal WAV (SHA-256
  `2976da01e205a110c9fa41d47659e238a5c6d3c3f3137582f2949853faa201dd`) exercises the selected
  inference path once. Only a structurally valid inference result clears readiness. The probe has
  a deadline, is cached, contains no learner audio, and never supports an accuracy claim.
- Transient load/probe failures retry through the same worker. A timed-out probe cannot overlap a
  replacement; liveness remains available and orchestration can replace the unready container.
- Compose and staging consume `/ready`, while W1.5 remains responsible for evaluated model
  selection, CPU/GPU packaging, capacity, and accuracy evidence.

### Consequences

An alive process can now report an actionable unready state without receiving traffic. A green
container implies loaded selected-model bytes, matching identity, and one completed inference
execution—not Quran-recitation quality. Image size and platform-specific PyTorch packaging remain
visible W1.5 work and cannot be disguised by this operational probe.

---

## ADR-0043 — Inference producers own component-level model attribution

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0038 (lean target), ADR-0042 (canonical integrity)

### Context

Learner inference crossed several independently versioned components—ASR, forced alignment,
Quran-constrained alignment, acoustic scoring, and calibration—but responses and database writes
carried one free-form `modelVersion`. Flutter could submit that value, public proxies accepted a
former allowlist, session alignment writes fell back to `model-v0.3`, and the ML service could use
an environment label unrelated to the executable artifact. A label could therefore survive while
the producing bytes, dataset, or component changed.

### Decision

- A model result carries schema-versioned records from the closed component vocabulary `asr`,
  `forced-aligner`, `quran-aligner`, `acoustic-scorer`, and `calibrator`.
- Every active record names a non-empty implementation id, an exact lowercase `sha256:` artifact
  digest, a dataset version, an analysis basis, and any calibrator linkage. An unavailable
  component states why and cannot claim an artifact.
- The inference producer authors and validates attribution. Public clients cannot submit
  `modelVersion` or `modelAttribution`; Node and Rust proxies fail closed before returning a 200
  when the producer record is absent, unknown, malformed, duplicated, or inconsistent.
- The transitional `modelVersion` response field is derived from the primary component's
  implementation id. It is compatibility data, never model-selection authority.
- Bare OpenAI Whisper is digest-bound to the verified checkpoint URL. A Hugging Face ASR or forced
  aligner alias without an explicitly deployed artifact digest is unavailable rather than guessed.
  The Quran aligner and deterministic acoustic scorer hash their exact executable source bytes.
- Session creation selects the sole configured alignment model server-side. Alignment persistence
  inherits the session's selected identity; it never takes a request value or fallback.

### Consequences

Unknown or ambiguously deployed artifacts now stop inference instead of producing untraceable
learner data. Model replacement requires an explicit producer record and digest. W1.8 will persist
and read back these component records through the restricted tenant path; this decision establishes
the authoritative response and boundary contract without prematurely changing that schema.

---

## ADR-0042 — Frame and pin both canonical ayahs and word tokens

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0041 (direct corpus provider)

### Context

The legacy full-corpus SHA-256 serializes `surah:ayah:text\n`. It protects all 6,236 ayah strings
but never reads the 82,456 parallel word tokens used by Quran-constrained alignment. A same-count
token edit could therefore keep the legacy checksum and every structural count green.

Delimiter-only formats also make their own assumptions about which bytes can occur in fields. A
canonical integrity format must be unambiguous without trimming, Unicode normalization, or a
character allowlist.

### Decision

- Keep the legacy checksum and `provenance-v1.json` immutable.
- Add append-only `provenance-v2.json`, checksum-pin v1, and hash the ayah and word-token streams
  independently with SHA-256.
- Frame the domain, every record, and every UTF-8 field with an unsigned 64-bit big-endian byte
  length. Ayah records contain `(surahNumber, ayahNumber, text)`; token records contain
  `(surahNumber, ayahNumber, wordIndex, text)` in canonical order.
- Declare the exact tokenization contract: one U+0020 between tokens; ayah 1:1 alone preserves a
  leading U+FEFF outside the token stream.
- The production SQL generator validates v1, v2, source/version metadata, counts, and token
  reconstruction before emitting SQL. Database columns and per-row checksums do not change.

### Consequences

A same-count token drift now fails independently of ayah text and per-row checksum tests. The
format is byte-unambiguous and portable to future Node/Dart/Rust implementations. A legitimate
corpus or tokenization correction requires a new versioned manifest and reviewed hashes; it never
rewrites this manifest or the shipped Quran files in place.

---

## ADR-0041 — Identify the shipped canonical corpus by its direct acquisition provider

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0040 (canonical seeds outside schema history)

### Context

The checked-in full-corpus importer and historical manifest identify Al Quran Cloud edition
`quran-uthmani`, but the production SQL generator later labeled every built record `tanzil`.
Source identity participates in canonical record checksums, so this was a provenance and database
integrity defect even though the Arabic text was unchanged.

The current provider response was compared with all 6,236 shipped ayah strings and matched exactly.
Al Quran Cloud's terms name several upstream sources but do not map this edition to one exact
upstream artifact. Calling the bytes Tanzil would therefore assert evidence the provider does not
publish.

### Decision

- The full corpus uses source id `alquran-cloud`, edition `quran-uthmani`, and import version
  `full-quran-2026-06-26`. `tanzil` remains available only for independently sourced fixtures or
  imports.
- The append-only `packages/quran-data/src/data/full-quran/provenance-v1.json` is the reviewed
  provenance authority. The original import manifest and Surah JSON files are historical acquisition
  material and are not rewritten.
- The full SQL generator uses the exported full-corpus source constant. Existing databases are
  upgraded through additive migration `0028_canonical_quran_source_id.sql`, then reseeded through
  that generator so source-bound checksums and metadata move together; rows are not relabeled while
  retaining old checksums. Historical migrations remain byte-identical.
- No Arabic ayah or word byte changes in this migration. Automated proof compares every old/new
  bundle text value and preserves the existing corpus hash. Word-token serialization hashing remains
  W1.2 and is not folded into this decision.

### Consequences

The database and review artifacts now state what the repository can prove: Al Quran Cloud is the
direct provider, while the edition-level upstream chain remains unresolved. Attribution names the
direct provider. A later upstream correction requires new primary evidence, a new versioned
provenance record, regenerated source-bound checksums, and the same byte-invariance gates.

---

## ADR-0040 — One checksum-locked database migration boundary

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0012 (RLS posture), ADR-0038 (lean Flutter/Node target)

### Context

Database setup had several competing histories: Docker init mounts stopped at migration 0021, CI
maintained its own 26-file loop, and staging, restore, smoke, and release could each apply SQL by a
different path. There was no database ledger or checksum comparison. A fresh database could
therefore differ from an upgraded one while both booted successfully, and the application role was
provisioned beside schema SQL despite having a different security and rotation lifecycle.

### Decision

- `infra/migrations/manifest.json` is the ordered, immutable source boundary. The 26 historical SQL
  files retain their original bytes and are pinned by SHA-256.
- `server/scripts/migrate.mjs` is the sole schema entry point for Compose, CI, staging, restore, and
  release. It uses an administrative `MIGRATION_DATABASE_URL`, holds a session advisory lock,
  applies each file and its `schema_migrations` row in one transaction, and refuses gaps, unknown
  rows, filename drift, checksum drift, or an unrecognized pre-ledger schema.
- Only the structurally fingerprinted historical 0021 and 0027 states may be adopted into the
  ledger. Fresh, adopted, and upgraded databases must produce the same schema fingerprint.
- `server/scripts/provision-role.mjs` separately creates or rotates `quran_ai_app`. Runtime services
  use that restricted login; they never receive migration authority. Full-corpus seeds remain
  versioned data artifacts outside schema migration history.

### Consequences

There is one auditable migration history and one operational command across every environment.
Startup now fails closed on drift and serializes concurrent deploys. Operators must supply separate
administrative and runtime credentials, and restore/release procedures must run migration and role
provisioning before application traffic starts.

---

## ADR-0039 — Generate the Flutter API boundary with pinned OpenAPI Generator `dart-dio`

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Related:** ADR-0026 (Flutter dependencies), ADR-0038 (target route contract)

### Context

The Flutter client is hand-written from an OpenAPI file and a Node test compares selected model
keys. That test catches useful drift, but it does not create request methods, auth wiring, typed
errors, or new models. Keeping a complete client synchronized by hand is not credible for the final
Flutter-only product.

The generator has to support Flutter Web, bearer and API-key security, composite schemas, and the
OpenAPI 3.1 contract while remaining reproducible. As checked on 2026-08-06, OpenAPI Generator
7.22.0 is the latest stable release. Its official `dart-dio` generator is marked stable, supports
authorization and composite/union schemas, and produces a cross-platform Dart client. The simpler
`dart` generator keeps the current `http` package but officially lacks authorization and union
support, so it is not an acceptable security boundary. Newer native-Dart generators were rejected
for now because they have very short release histories and much smaller field evidence.

Sources: [OpenAPI Generator 7.22.0 release](https://github.com/OpenAPITools/openapi-generator/releases/tag/v7.22.0),
[official `dart-dio` capability matrix](https://openapi-generator.tech/docs/generators/dart-dio/).

### Decision

- Use **OpenAPI Generator 7.22.0** with the **`dart-dio` generator** and its stable `built_value`
  serialization mode.
- The sole source is `packages/contracts/openapi.yaml`; generation never fetches a remote spec.
- Pin the generator artifact/version and configuration in the repository when W4.2 adds the tool.
  Generated output is deterministic and CI regenerates into a temporary directory and fails on a
  diff. Generated files are never edited by hand.
- `dio` replaces `http` at the completed API boundary; both networking stacks must not remain as
  permanent runtime dependencies. Realtime WebSocket and audio dependencies remain separate.
- Before any production caller migrates, the generated package must compile and prove required vs
  optional vs nullable semantics, all security schemes, error responses, enum behavior, and a
  byte-exact canonical Quran text round trip. A generator defect fails the migration; it is not
  patched around in handwritten generated files.
- No generator is installed in W0.2. Tool installation and generated-code review remain W4.2 so a
  dependency is not added months before it has a runtime caller.

### Consequences

Generation is reproducible and the client boundary becomes contract-driven, at the cost of one
eventual networking-stack replacement and generated `built_value` support dependencies. The
selection is intentionally pinned rather than `latest`; upgrades are explicit diffs with the same
generation and canonical-byte gates.

---

## ADR-0038 — Retire public password/agent routes and adopt controlled device enrollment

**Status:** Accepted · **Date:** 2026-08-06 · **Decider:** repository owner through the approved consolidation plan
**Supersedes:** ADR-0020 (open learner self-registration); ADR-0025 (proposed Node bcrypt dependency)
**Preserves:** ADR-0002 (login stays off until the owner declares production)

### Context

The measured runtime baseline is 42 method/path operations. Four are wrong for the final product:
open password registration lets a caller create identities, password login would force the lean
Node target to retain bcrypt and a public login UI, and the generic agent-run read/write pair exposes
an internal orchestration record as product API. None is needed for the Kurdish Quran practice loop.

Native Flutter still needs real, revocable identity and delayed reviewed feedback. The browser-only
`__Host-qrai-pilot` cookie cannot be the native credential boundary, and the staff session list must
not be weakened into a learner history endpoint.

### Decision

The final target retires exactly:

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/agent-runs`
- `POST /v1/agent-runs`

They remain served and contracted during the strangler period. Each current production caller is
recorded in `packages/contracts/route-manifest.json`; removal is forbidden until that inventory is
empty, compatibility tests are replaced, and the relevant canary/rollback gate has passed.

The target adds these separately specified operations:

- `POST /v1/device-enrollments:exchange` — exchange one single-use, expiring invitation for a
  server-derived learner/device session; a caller never chooses tenant or role.
- `POST /v1/device-sessions:refresh` — rotate the device credential; replay of an already-rotated
  credential fails closed.
- `DELETE /v1/device-sessions/current` — revoke the current device session and make logout real.
- `GET /v1/learner/recitation-sessions` — paginated own-only history for delayed teacher feedback;
  the privileged staff listing remains unchanged.

Staff and scholar identities are provisioned by authorized administrators, never self-selected.
Raw invitation and refresh credentials are returned only at their intended exchange, stored only as
hashes server-side, and never logged. Native secrets belong in Keychain/Keystore. The server may
implement and contract these operations as `implemented-owner-gated`, but it must not register
them unless the owner-controlled `DEVICE_IDENTITY_ENABLED=1` switch is explicit; this ADR does not
re-enable Web login.

The manifest classifies every baseline operation as retained or retired and lists additions
separately. Counts are computed from those sets: 42 baseline, four retirements, 38 retained baseline
operations, and four additions. There is no independent target-count field that can drift.

### W2.16 implementation note (2026-08-07)

The Node boundary now implements the three device-identity operations behind the default-off
`DEVICE_IDENTITY_ENABLED=1` owner gate. Additive migration 0035 stores only SHA-256 invitation,
access, and refresh hashes under forced tenant RLS. Invitations are 256-bit opaque values with a
fixed 24-hour lifetime. An exchange creates server-derived identity with a 15-minute access
credential, seven-day idle lifetime, and 30-day absolute family lifetime. Refresh rotates both
credentials and retains a generation chain; refresh replay revokes the entire credential family
before returning a generic 401. Logout also revokes the family.

`server/scripts/provision-device-enrollment.mjs` is the sole operator provisioning boundary. It
requires a stored in-tenant admin, creates only learner/teacher/scholar users when explicitly given
all approved fields, records an audit event, generates the invitation internally, and returns its
raw value once. It cannot create admin/ops users or accept a session role, tenant, invitation, or
credential chosen by an HTTP caller. Privacy export exposes only nonzero device-row counts; delete
removes the learner's device sessions and invitations inside the existing fenced tenant transaction.
This implementation does not activate the routes, re-enable Web login, or complete native secure
storage/attestation work; W4.10 and independent security approval remain release gates.

### Consequences

The proposed bcrypt dependency is no longer required for the final Node service. Current password,
agent service, fixture-capture, and privacy-audit paths continue only as transition surfaces and
must migrate before deletion. Pilot invitation/cookie operations remain available for browser
compatibility until their own client-retirement gate; this decision does not silently expand the
four-route retirement set.

---

## ADR-0020 — Open learner self-registration is retained for the pilot (F2)
**Date:** 2026-07-24 · **Status:** Accepted (owner decision)

**Context.** The 2026-07-23 adversarial audit flagged F2: `POST /v1/auth/register` allows
unauthenticated self-registration for `role == learner` and returns a learner Bearer JWT for the
(hardcoded) pilot tenant, coexisting with the admin-minted invitation path (ADR-0019). It bypasses
"invitation-only" and permits account/spam creation (rate-limited only).

**Decision.** Keep open learner self-registration for the pilot. The owner accepts it as a valid
entry path alongside invitations.

**Why it is bounded (residual risk accepted).** The minted JWT is `learner`-scoped only; every
handler enforces `require_self_or_any` + RLS, so a self-registered account sees only its own (empty)
rows — no cross-tenant/cross-user access (audit: no IDOR). Elevated-role registration stays gated
(an authenticated Admin/Ops caller + tenant match, `user.rs`). Abuse is limited to spam account
creation, mitigated only by the Governor rate limiter.

**Consequences.** "Invitation-only" is a soft convention, not a hard gate, during the pilot. If spam
becomes a problem, gate `register` (learner role) behind an `ALLOW_OPEN_REGISTRATION` flag or require
an invitation — a small, localized change. Revisit before any wider launch.

---

## ADR-0019 — Pilot invitations: admin-minted, single-use, hash-stored; the web exchanges them for the `__Host-qrai-pilot` cookie
**Date:** 2026-07-23 · **Status:** Accepted

**Context.** ADR-0002 disables login for the pilot; the current default identity is a hardcoded
`learner-1` sent via spoofable `x-user-id`/`x-tenant-id` headers (gated by `ALLOW_HEADER_AUTH`). The
pilot-identity feature (`specs/pilot-identity-hardening`, #238) added a server-authoritative
`__Host-qrai-pilot` cookie plus `bootstrap`/`logout`, but `research.md` flagged that the
"invitation-issuance mechanism is not present anywhere" and the web never consumed the cookie — so
the boundary existed but was unused (P1.6 open).

**Decision.**
- **Issuance:** `POST /v1/pilot/invitations` (Admin/Ops, own tenant only) mints a single-use
  invitation for a learner. The raw token is returned exactly once; only its SHA-256 hash is stored.
  TTL defaults to 7 days (168h), clamped to [1h, 30d]. Non-learner or cross-tenant targets are rejected.
- **Redemption:** the learner opens `?invite=<token>`; the web calls `bootstrap` (credentials
  included) to receive the cookie, stores the returned identity + CSRF token in `lib/pilotSession`,
  and strips the token from the URL/history.
- **Requests:** in pilot mode the web sends the cookie (`credentials:"include"`) plus `x-csrf-token`
  on mutations, and STOPS sending `x-user-id`/`x-tenant-id`. Identity is server-derived from the
  cookie; request-body fields (e.g. `learnerId`) are non-authoritative.
- **Additive:** with no invite and no stored session the app keeps the existing default/dev-header
  path unchanged, so nothing breaks for local dev or the smoke suite.

**Consequences.**
- Learners get a real, revocable, per-user identity without a login screen (ADR-0002 preserved).
- To fully close the header-spoofing gap in production the deployment must set `ALLOW_HEADER_AUTH`
  off and distribute invite links; that flip, the live-browser walkthrough (P1.6 proof), and the
  security-reviewer sign-off (P1.7) are the remaining pilot-identity steps.
- `CORS_ALLOWED_ORIGINS` MUST be set to the exact web origin(s) in production. It gates both the
  pilot Origin allowlist and browser CORS; when empty both degrade to permissive. As of the F1
  hardening, `platform-api` **fails closed on boot** if it is empty while `ALLOW_INSECURE_DEFAULTS`
  is off (mirroring the realtime gateway and the JWT/ticket/ML/ASR secret checks), so a misconfig is
  loud rather than a silently decorative Origin check.
- Invitation *distribution* (email/SMS/hand-out) is out of scope: the endpoint returns the token and
  an optional `inviteUrl` (when `PILOT_INVITE_BASE_URL` is set); an operator delivers it.

---

## ADR-0018 — Release evidence is external, candidate-bound, and fail-closed
**Date:** 2026-07-19 · **Status:** Accepted for engineering implementation

**Context.** The original `scripts/release-manifest.mjs` writes its manifest
inside the source checkout and then accepts either `HEAD` or `HEAD~1` as the
candidate. That makes it possible for a stale manifest to appear valid after a
second commit. It also ignores untracked files and accepts missing container
image digests. The current manifest demonstrated all of these weaknesses: it
was bound to an older commit and contains null image digests.

**Decision.** Release evidence version 2 is generated as an external CI/release
artifact, never as a tracked or untracked file inside the candidate checkout.
Its verifier SHALL require the exact current candidate SHA, a completely clean
working tree including untracked files, non-empty digests for every deployable
service, and matching hashes for the declared candidate files. It SHALL also
bind a passing build summary, SPDX SBOM, aggregate smoke summary, test summary,
environment summary, expiry, and an Ed25519 signature to that exact candidate.
The signer is selected from a trusted-signer policy rather than an arbitrary
public-key command-line argument; the policy's hash and ID are themselves
signed into the evidence.

The trusted-signer policy is a release-control input, not candidate-owned
source. The protected CI/release environment must mount and pin it; supplying
an arbitrary policy while running the command locally does not create a trusted
release. Version-1 manifests are historical evidence and cannot certify a new
release. The evidence artifact is not, by itself, release authorization:
approval, protected CI wiring, independent challenge, and operational evidence
remain mandatory follow-up work in the readiness-recovery ledger.

**Consequences.** A release engineer or CI job must provide an external manifest
path, trusted-signer policy, and candidate-bound build/SBOM/smoke/test/
environment summaries when generating or verifying a candidate. Existing
`number-one-release` manifests will deliberately fail verification. A clean,
reproducible positive path can be proven without a self-referential evidence
commit, while any developer-local or incomplete evidence is rejected rather
than softened.

---

## ADR-0014 — Scholar review and approval of Tajweed rule scope
**Date:** 2026-07-15 · **Status:** Approved
**Reviewer:** Sheikh Hisham al-Erbili (mujawwid, Erbil Pilot Advisor)

**Context.** As required by Phase 1 Task 1.1, the rule-based Tajweed engine must be signed off by a qualified scholar before release. The scholar review packet (`docs/SCHOLAR_REVIEW.md`) lists the per-word and inter-word rules, simplifying constraints, and open questions.

**Decision.**
Sheikh Hisham al-Erbili reviewed the packet and approved the scope with the following responses to the six questions:
1. **A1 — detection correctness:** The sites where the Madd Tabii, Madd Maleki, Qalqalah, Tafkhim, Shaddah, Idgham, Iqlab, and Ikhfa rules fire are doctrinally correct for Hafs an Asim.
2. **A1 — acceptable simplifications:** Yes, the simplifications (e.g., Madd types not distinguished, Tafkhim on presence without rā' or Allah's lām, Idgham not split) are acceptable for a practice-assist tool under the condition that all outputs are teacher-reviewed and labeled provisional.
3. **A1-1 — mushaddad ghunnah:** Approved to be withheld from this release (per ADR-0013) to ensure no incorrect claims are made.
4. **A1-2 — ghayn in tafkhim:** Approved to omit `غ` for the current version; its omission is acceptable for practice assistance.
5. **A3 — labelling:** Yes, "AI suggestion · not yet reviewed" combined with teacher-gating is a sufficient and honest frame.
6. **Withhold list:** Only mushaddad ghunnah is withheld, which is already correctly handled by not generating it.

**Consequences.** The Tajweed engine's rule scope is officially signed off and cleared. No additional code changes are needed to modify the active rule list for this release.

---

## ADR-0013 — Explicit release gating of the mushaddad ghunnah Tajweed engine limitation
**Date:** 2026-07-15 · **Status:** Accepted (withheld, with explicit warning)

**Context.** The rule-based tajweed engine (`services/ml-inference/tajweed.js`) handles natural madd, dagger alif, coarse ghunnah, and qalqalah. However, it does not currently implement nūn/mīm mushaddad ghunnah (obligatory nasalisation on نّ/مّ, e.g. in `إِنَّ`, `ثُمَّ`), which is marked as a `TODO` in `services/ml-inference/tajweed.test.mjs`. In a religious-education and Quran-learning product, shipping an AI/rule-based engine that silently ignores this rule or conflates it with simple shaddah without scholar sign-off poses a doctrinal correctness risk.

**Decision.**
1. We explicitly **withhold** mushaddad ghunnah from the active rule-detection set for the current release. The engine will continue to flag simple consonant doubling (`shaddah`) without incorrectly claiming it has graded the obligatory ghunnah nasalisation.
2. We added a visible note in the scholar review guidelines (`docs/SCHOLAR_REVIEW.md` Question A1-1) to ensure the next iteration of the engine (which will implement the two-count mushaddad ghunnah detection) is reviewed and signed off by a qualified scholar before it is enabled.
3. For general transparency, the learner-facing interface labels all AI-generated tajweed suggestions as *"AI suggestion · not yet reviewed"* and gates them behind the contract's teacher review/approval gates (`contracts` check `canShowLearnerFacingAiOutput`), preventing any unverified feedback from reaching the student.

**Consequences.** At the time of this ADR, the scoped Tajweed behavior did not
present half-implemented or unverified feedback to the learner. This
component-level conclusion is not a current release-readiness claim; any new
candidate still requires the recovery ledger's full source, evaluation, and
scholar evidence. Implementing and signing off on the mushaddad ghunnah rule
remains a post-release enhancement requiring a qualified scholar's verification
packet sign-off.

---

## ADR-0012 — i18next/react-i18next for web i18n; content ships English-only
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** `apps/web`'s language dropdown has listed 9 languages (Arabic, Kurdish Sorani —
the pilot's actual default, English, Turkish, Urdu, Indonesian, Malay, French, German) since
early in the project, but there was zero i18n infrastructure: no library, no string extraction,
no translation files. `activeLanguage` only picked which native name to display in the dropdown
and tagged session metadata sent to the backend — every actual UI string stayed hardcoded
English regardless of the selection (`docs/SHIP_READINESS.md` F18).

**Decision.** Added `i18next` + `react-i18next` (new runtime dependencies,
`apps/web/src/i18n/index.ts`) and extracted every hardcoded UI string across the app into
`apps/web/src/locales/en.json`. The other 8 languages are registered with empty resource
bundles and fall back to English (`fallbackLng: "en"`) rather than shipping AI-fabricated
translations. Real translations for a religious-education product need native-speaker/scholar
review before they ship — the same reasoning `docs/SCHOLAR_REVIEW.md` already applies to
tajweed content — so guessing at 8 languages' worth of UI copy would trade an honest, visible
gap for a dishonest, invisible one. This mirrors the "no fake data" principle already
established elsewhere in this codebase (e.g. `data/quran.ts`'s real vs. synthetic progress
data). Canonical Quran text, tajweed rule content, and real backend/dynamic data (agent run
names, teacher review notes, scholar approval topics) are explicitly excluded from translation
throughout, each with an inline comment.

**Consequences.** Switching the language dropdown today re-renders through real i18next
machinery and correctly falls back to English for the 8 untranslated languages — verified live
in the browser and via a regression test asserting `i18next.language` actually changes and
untranslated languages still render real English text, not raw translation keys. Before any of
the 8 languages can ship real content: (1) prioritize which languages the pilot actually needs
first (Kurdish Sorani is the immediate candidate, being the pilot's default), (2) establish a
native-speaker/scholar review process for the translated strings, (3) populate the
corresponding `apps/web/src/locales/<code>.json` files. None of that is a technical blocker —
the infrastructure and extraction are done — it's a product/review-process decision, tracked as
an open item until an owner scopes it.

---

## ADR-0011 — apps/mobile's npm audit findings are build-tooling-only, not shipped
**Date:** 2026-07-08 · **Status:** Accepted (tracked, not fixed)

**Context.** `apps/mobile` had never had `npm install` run this session (per `docs/
SHIP_READINESS.md` B5: the mobile app's UI/native path has never been run at all, even in the
most basic sense). Ran it for the first time to check for install-time issues. It installed
cleanly (656 packages) but `npm audit` reported 11 moderate-severity findings, all reducing to
two root advisories: `postcss <8.5.10` (XSS via unescaped `</style>` in CSS stringify output,
GHSA-qx2v-qp2m-jg93) and `uuid <11.1.1` (missing buffer bounds check, GHSA-w5hq-g745-h8pq).

**Reachability analysis.** Neither `postcss` nor `uuid` is a direct dependency of `apps/mobile`
(confirmed via `package.json`) or imported anywhere in the app's own source (`grep -rn "postcss\|
uuid" App.tsx lib/*.ts index.ts` — zero matches). Both are transitive dependencies of Expo's own
build/CLI tooling: `postcss` via `@expo/metro-config` (Metro bundler's CSS pipeline, a
build-time-only concern — this app's UI is React Native, not CSS), and `uuid` via `xcode` (an
`@expo/config-plugins` dependency that generates native Xcode project files during a native
build, never invoked by the running app). Neither package ships in, or is reachable through, the
compiled mobile app a learner would run.

**Decision.** Do NOT run `npm audit fix --force` in this pass. It would install `expo@57.0.4` — a
four-major-version jump from the currently pinned `~53.0.0` — for an app that has never been
run on a device or even started once, with no real-device testing capability available to verify
nothing broke. This is the same reasoning already applied in ADR-0009 to `services/tajweed-
neural`'s `transformers` CVE: a blind major-version bump on unreachable/build-tooling-only code
risks introducing real breakage to fix a vulnerability that was never exploitable in production.

**Consequences.** Tracked here as the source of truth for this decision, per the same convention
established in ADR-0009 and ADR-0008. Before `apps/mobile` is promoted out of "never run on a
device" status (`docs/SHIP_READINESS.md` B5), re-run `npm audit` against whatever Expo SDK
version is current at that time — Metro/CLI tooling versions move independently of the app's own
code, so this may already be resolved by then without any deliberate action here.

---

## ADR-0010 — Web image runs nginx-unprivileged with a full restrictive CSP
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** `apps/web`'s Docker image ran `FROM nginx:alpine`, which starts its master process as
root by default — the only one of the five service images not enforcing the non-root posture the
other four (`platform-api`, `realtime-gateway`, `ml-inference`, `asr-inference`) already have via
an explicit `useradd`/`USER appuser` (uid 10001). Separately, `nginx.conf`'s Content-Security-Policy
only set the directives that could never break the SPA regardless of deployment (`frame-ancestors`,
`base-uri`, `object-src`, `form-action`) — `default-src`/`script-src`/`style-src`/`connect-src` were
deliberately left unset, with a comment explaining they needed per-deployment testing against the
running app.

**Decision.** Switched the base image to `nginxinc/nginx-unprivileged:alpine`, which runs as UID 101
by default (a different UID than the backend services', since it's a different upstream image's
convention — no `useradd` needed). Unprivileged processes can't bind ports under 1024, so nginx now
listens on 8080 instead of 80, with `docker-compose.yml`'s port mapping and healthcheck updated to
match. Added the full CSP this deployment's real requirements support: `default-src 'none'` with
explicit per-directive allowlists, `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`),
`style-src 'self' 'unsafe-inline'` (React's dynamic inline styles — the mastery ring, accuracy ring,
and audio waveform bars all set `style={{ ... }}` directly), `connect-src 'self' ws: wss:` (the
nginx `/v1/` proxy plus the realtime gateway's WebSocket, which currently connects on a different
port than the page's own origin), and `media-src` including `cdn.islamic.network` (the real
reference-recitation audio source).

A strict `connect-src 'self'` only holds if the web app's own `fetch` calls are same-origin in
production. Every API-base-URL fallback across the client/data modules hardcoded an absolute
`http://127.0.0.1:8080`, which would bypass the nginx proxy and violate `connect-src 'self'`
outside dev — fixed by branching on Vite's build-time dev flag (absolute in dev, relative in the
production build). While touching those call sites, also switched every remaining raw `fetch()`
among them to the existing timeout-wrapped helper (`lib/http.ts`), so a hung backend can no longer
leave a login/register/progress call unresolved indefinitely.

Also discovered and fixed while verifying this: `nginx-unprivileged:alpine` has no `curl` (only the
four backend images install it for their healthchecks), so the compose healthcheck's `curl -f`
would have failed every 10 seconds forever once bound to the new base image — switched to a
`wget`-based check, available in Alpine by default. The same curl-availability gap was found and
fixed independently in `services/ml-inference/Dockerfile` around the same time.

**Consequences.** All five service images now run non-root. CI's `docker-build.yml` still only
asserts the non-root UID for the four backend services (uid 10001) — a matching assertion for the
web image's uid 101 has not been added, since that requires editing a CI-protected workflow file;
tracked as an open follow-up. The CSP is a hard boundary going forward: any new third-party script,
font, image, or media source added to the web app must be added to the corresponding directive in
`apps/web/nginx.conf`, or the browser will silently block it in production while dev keeps working
uninterrupted (CSP is only enforced by nginx, not the Vite dev server).

---

## ADR-0001 — Adopt the CODYSTEM harness as the governance + gate layer
**Date:** 2026-06-30 · **Status:** Accepted

**Context.** quran-ai-platform is a polyglot monorepo (TS + Rust + Node/Python services)
with an existing strict script (`scripts/proof.sh`) but no version control, no enforced
agent operating rules, and no single "done" definition.

**Decision.** Adopt CODYSTEM: `AGENTS.md`/`CLAUDE.md` operating rules, the Research → Plan →
Implement skills, deterministic `.claude` hooks (PreToolUse guard, PostToolUse fast verify,
Stop full verify), and `scripts/verify.sh` as the canonical gate. `verify.sh` runs the
infra-free core always (Rust fmt/clippy + TS typecheck + TS/Rust tests + build) and gates
the Postgres-only platform-api integration tests behind a reachable DB (skipped, never faked).
CI runs the same script, so local == CI. The repo is now under git.

**Consequences.** "Done" = `verify.sh` green AND required CI green — never agent judgment.
`scripts/proof.sh` is retained as the equivalent strictest local gate (it additionally
requires Postgres for platform-api). Follow-up: wire branch protection once a remote exists,
and optionally add a Postgres service to CI to run the DB-gated tests.

---

## ADR-0002 — Login is DISABLED for general users until production (owner-gated)
**Date:** 2026-07-01 · **Status:** Accepted (STRICT — do not change without the product owner)

**Context.** During the pilot/preview the product owner requires that general users reach
the app with **NO login step** — no sign-in screen, no account creation, no query-param
workaround. Authentication must stay off until the owner explicitly says the app is going
to production.

**Decision.** The web app renders directly with a default learner and **no login screen**.
This is controlled by a single build-time switch in `apps/web/src/App.tsx`:

    const LOGIN_ENABLED = import.meta.env.VITE_REQUIRE_LOGIN === "1";

- Default (env unset) → `LOGIN_ENABLED = false` → app renders `<AuthenticatedApp bypassLogin />`
  with a default learner (`learner-1` / `hikmah-pilot-erbil`). No `LoginScreen`, no `?smoke`.
- To RE-ENABLE login for production: set `VITE_REQUIRE_LOGIN=1` at build time. **Only the
  product owner authorizes this** — agents/contributors must NOT flip it on their own.

The `LoginScreen`, `register()`, and `login()` code is retained and wired; it is simply not
reachable until the flag is on.

**Consequences.** No credentials are required to use the pilot. The platform-api still
supports real auth (JWT + `/v1/auth/*`) for when login is turned on. Because there is no
per-user identity in bypass mode, all pilot activity is attributed to the default learner.

---

## ADR-0003 — ML inference accessed only through platform-api proxy
**Date:** 2026-07-03 · **Status:** Accepted

**Context.** The web frontend was calling the ML inference service directly, exposing
`VITE_ML_API_KEY` in the browser bundle. Any user could extract this key and call the ML
service without authentication.

**Decision.** Add `/v1/ml/alignments:predict` and `/v1/ml/tajweed-findings:predict` proxy
routes to `platform-api`. The frontend calls these endpoints (authenticated via JWT). The
platform-api forwards requests to the ML service, attaching the `ML_API_KEY` server-side.
New runtime dependency: `reqwest` (HTTP client) in `platform-api`, with a shared
`reqwest::Client` on `AppState` for connection pooling.

**Consequences.** ML API key never reaches the browser. The ML service is no longer
exposed on the public network (only reachable from `platform-api` on the internal Docker
network). Adds ~1ms of proxy latency per ML call.

---

## ADR-0004 — Canonical checksum upgraded from FNV-1a 32-bit to SHA-256
**Date:** 2026-07-03 · **Status:** Accepted

**Context.** Canonical Quran data checksums used FNV-1a 32-bit (`fnv1a32:` prefix), which
has a 32-bit collision space (~77k records for 50% collision probability). While adequate
for the current dataset, this is insufficient for long-term integrity guarantees.

**Decision.** New checksums use SHA-256 (`sha256:` prefix). The `verifyCanonicalWord` and
`verifyCanonicalAyah` functions accept both formats: they first check against SHA-256, then
fall back to FNV-1a for backward compatibility with existing seed data (which is immutable
per AGENTS.md). Implementation uses a pure-JS SHA-256 (FIPS 180-4) — no Node.js-only
dependencies — so it works in both the Node test environment and the browser bundle.

**Consequences.** Existing `fnv1a32:` checksums in seed SQL remain valid. New imports
produce `sha256:` checksums. A backward-compatibility test locks this contract. The pure-JS
implementation adds ~0.1ms per checksum vs. the native `node:crypto` path, which is
acceptable for the import/verification use case (not on a hot path).

---

## ADR-0005 — Full-Quran seed script now shares the real checksum builder; re-seed required for any already-seeded database
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `packages/quran-data/scripts/seed-full-quran-to-db.sh` computed each row's
`source_checksum` inline as `fnv1a32(rawText)` — a hash of the Arabic text alone. Both
`verifyCanonicalWord`/`verifyCanonicalAyah` (the only functions in the codebase that
validate these checksums) reconstruct the checksum from `canonicalWordPayload`/
`canonicalAyahPayload` — a pipe-joined string of `id|quranRef.display|ayahId|wordIndex|
text|sourceId|edition|scriptType|importVersion` — and this is true of *both* the SHA-256
path and the legacy FNV-1a fallback added in ADR-0004 (`legacyFnv1aChecksum` also hashes
the full payload, not raw text). So every row the production seed script wrote for the
real 114-surah corpus — including the currently-deployed `hikmah-pilot-erbil` database, if
already seeded from this script — has a `source_checksum` that neither verification path
can validate. This was latent (nothing calls `verifyCanonicalWord`/`verifyCanonicalAyah`
against the live DB today), not an active bug, but a real integrity gap: if a periodic
integrity sweep or a future write-path check is ever added, every full-Quran row fails it.

**Decision.** Reuse the existing, tested checksum machinery instead of re-deriving it a
third time:
1. `packages/quran-data/src/index.ts` gains `buildFullQuranSurahBundle(surah, sourceId,
   importVersion)`, generalizing `buildCanonicalAyah`/`buildCanonicalWords`/
   `createAyahReference`/`createWordReference` (previously Fatihah-only, hardcoding the
   `"Al-Fatihah"` display label) with a `surahLabel` parameter that defaults to
   `"Al-Fatihah"` — so `buildFatihahImportBundle`'s existing checksums are byte-for-byte
   unchanged. It calls the same `createCanonicalChecksum`/`createCanonicalAyahChecksum`
   functions `verifyCanonicalWord`/`verifyCanonicalAyah` actually check against.
2. `toCanonicalSqlSeed` now emits `ON CONFLICT (id) DO UPDATE SET ... source_checksum =
   excluded.source_checksum` (previously no conflict handling at all) for both
   `canonical_ayahs` and `canonical_words` — re-running the seed against an
   already-seeded database corrects every row's checksum in place; no separate migration
   or one-off `UPDATE` script is needed.
3. `packages/quran-data/scripts/write-full-quran-sql-seed.mjs` (run via `jiti`, the
   existing pattern used by `seed:sql`/`seed:json`) generates the full 114-surah SQL from
   `buildFullQuranSurahBundle`, printed to stdout rather than committed (at ~12MB it is a
   regenerable build artifact, not a migration).
   `seed-full-quran-to-db.sh` now pipes this script's output into `psql` instead of its
   previous broken embedded `node -e` snippet.
4. `packages/quran-data/tests/full-quran-checksum-integrity.test.ts` proves
   `verifyCanonicalAyah`/`verifyCanonicalWord` accept every one of the real 6236 ayahs and
   all their words across all 114 surahs — not just the 7-ayah Fatihah fixture.
5. The dead, never-invoked `fnv1a32`/`sha256` helper functions in
   `packages/quran-data/scripts/fetch-full-quran.mjs` are removed (a third, unused
   duplicate of this same logic).

**Consequences.** Any database already seeded by the old
`seed-full-quran-to-db.sh` (this includes the `hikmah-pilot-erbil` pilot database, if it
was seeded from the full-Quran script rather than only the Fatihah migration) has
`canonical_ayahs`/`canonical_words` rows with checksums in the old, unvalidatable format.
**Re-running `seed-full-quran-to-db.sh` against that database self-heals it** (the new
`ON CONFLICT ... DO UPDATE` corrects `source_checksum` — and defensively `text_uthmani` —
in place; no downtime or manual migration required), but this must be run deliberately by
whoever operates that database, and coordinated with them before running it against a
live pilot. No production code path currently depends on these checksums validating (the
gap was latent), so there is no user-facing regression from delaying the re-seed — but it
should happen before any integrity-sweep or write-path checksum validation is added.

---

## ADR-0006 — realtime-gateway now initializes a tracing subscriber
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `services/realtime-gateway/src/main.rs` never called
`tracing_subscriber::fmt().init()` (or any subscriber init), and `tracing-subscriber` was not
even a listed dependency — only the `tracing` facade crate was. Every `tracing::info!`/`warn!`
call throughout `lib.rs` — including CSWSH origin-rejection warnings, ticket validation
failures, and rate-limit events, all security-relevant — was silently dropped with nowhere to
go. Found by manually running the gateway locally: a rejected WebSocket connection produced no
log output at all, even at `RUST_LOG=debug`. `services/platform-api/src/main.rs` already
initializes a subscriber correctly; the gateway had simply never had this wired up.

**Decision.** New runtime dependency: `tracing-subscriber = { version = "0.3.20", features =
["env-filter"] }` in `services/realtime-gateway/Cargo.toml` (same version/features
`platform-api` already uses). `main.rs` now calls `tracing_subscriber::fmt().with_env_filter(...)
.init()` before binding the listener, defaulting to
`"quran_ai_realtime_gateway=info,tower_http=info"` when `RUST_LOG` is unset — mirrors
`platform-api`'s exact pattern.

**Consequences.** The gateway now actually emits its existing `tracing::warn!`/`info!` calls to
stdout in production, matching `platform-api`'s observability. No behavior change to request
handling — this only makes already-written log statements visible. Verified: the same connection
that previously failed silently now logs `realtime ticket tenant 'X' does not match gateway
tenant 'Y'` (or the relevant CSWSH/ticket-validation reason) immediately.

---

## ADR-0007 — Automated accessibility audit via axe-core (F17)
**Date:** 2026-07-07 · **Status:** Accepted

**Context.** `docs/SHIP_READINESS.md` F17 called for "an axe/Lighthouse pass on the web app" with
no automation in place — the only prior attempt this session was a hand-rolled contrast/focus
checker in ad-hoc browser JS, which produced three false positives (missed `linear-gradient`
backgrounds, misused `getComputedStyle`'s pseudo-element parameter for a pseudo-class, and was
fooled by a stale scroll position) before a single real finding. Manual DOM probing is not a
reliable substitute for a real accessibility engine.

**Decision.** New dev dependency: `axe-core` on `@quran-ai/web`. `scripts/smoke-a11y.mjs` (new,
root-level, following `scripts/smoke-browser.mjs`'s existing headless-Chrome-via-DevTools-Protocol
pattern) injects axe-core's bundled source into a real running instance of Learner Home, the
practice flow, and Internal Command, and fails on any violation. Exposed as `pnpm smoke:a11y`,
alongside the existing `smoke:*` commands — not part of `scripts/verify.sh`, matching every other
smoke script's convention (they validate a deployed/running stack, not a code diff).

**Consequences.** This audit caught one real, previously-unknown WCAG AA failure on first run:
`--muted` (`#7b7466`) measured 4.42-4.44:1 against the app's lightest paper backgrounds, just under
the 4.5:1 required for normal-size text (`.platform-app small`, `.capture-state`/`.gateway-state`
status text). Darkened to `#777163` — a visually near-identical shade — which clears 4.5:1 with a
comfortable margin everywhere `--muted` is used, not just the two flagged elements. `pnpm
smoke:a11y` now passes with 0 violations across all three audited screens. axe-core only catches
mechanically-detectable issues (contrast, missing labels/roles/landmarks) — it cannot verify
keyboard-only task completion or screen-reader announcement quality, so F17's manual pass remains
open (see `docs/SHIP_READINESS.md`).

---

## ADR-0008 — Dependency vulnerability scanning via cargo-audit (best-effort)

**Date:** 2026-07-07 · **Status:** Proposed (implementation blocked — see Consequences)

**Context.** `scripts/verify.sh` has no dependency-vulnerability scanning for either Rust
service. Running `cargo audit` locally against `services/platform-api` surfaces
`RUSTSEC-2023-0071` (the `rsa` crate's Marvin Attack timing side-channel, no fixed version
available upstream) via `sqlx-macros-core`, which lists `sqlx-mysql` (which depends on `rsa`) as a
Cargo.lock dependency edge — even though `platform-api`'s enabled `sqlx` features are
`["runtime-tokio", "postgres", "uuid", "json", "chrono"]`, with no `"mysql"` feature requested
anywhere in the workspace. Verified with `cargo tree -e normal,build,dev -i rsa` (and the same for
`-i sqlx-mysql`) across all targets from `services/platform-api`: both print "nothing to print",
confirming `rsa` is not part of the actually-compiled dependency graph. `services/realtime-gateway`
(no `sqlx` dependency) audits clean with zero findings. This is `cargo-audit`'s documented
lockfile-vs-feature-graph limitation — it scans every package recorded in `Cargo.lock`, not what a
given feature selection actually compiles — not a real vulnerability reachable in the shipped
binary.

**Decision.** `scripts/verify.sh` should add a best-effort `cargo audit` step, matching the exact
pattern already used for the live-Postgres-gated integration tests: run it if `cargo-audit` is
installed, SKIP with an honest message (never a false "VERIFY OK") if it isn't. When run, it should
pass `--ignore RUSTSEC-2023-0071` for `platform-api` only (not `realtime-gateway`, which has no
occasion to need it), with a comment pointing back to this ADR for the justification above.
`.github/workflows/ci.yml` does not currently install `cargo-audit` (only
`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`), so this only protects local runs by
default until a maintainer separately decides whether the ~30s `cargo install cargo-audit --locked`
step is worth the added CI time on every run — that tradeoff belongs in `ci.yml`, not here.

**Consequences.** `scripts/verify.sh` is a CODYSTEM enforcement file requiring a human-audited
`.codystem-allow-self-edit` sentinel to modify — the agent that investigated this (confirmed the
`rsa` finding is a false positive, and worked out the exact ignore-flag fix above) could not apply
it. This ADR exists so the next session/human implementing the change doesn't have to re-derive the
investigation. Until implemented, neither Rust service has automated dependency-vulnerability
scanning in the gate.

---

## ADR-0009 — transformers CVE tracking (services/tajweed-neural) and a false "already tracked" claim

**Date:** 2026-07-07 · **Status:** Accepted (tracking); upgrade deferred

**Context.** `docker-compose.yml`'s `asr-inference` service comment claimed switching to the
specialized Quran ASR model has "real costs (transformers as a new prod dependency — see the
pinned CVEs already tracked for it in services/tajweed-neural's lockfile)". No such tracking
existed anywhere in the repo — `grep -rn "CVE-" .` (excluding `node_modules`/venvs) returned zero
matches before this ADR. The claim was false.

Actually running `pip-audit` against `services/tajweed-neural/requirements.lock.txt` (via its own
`.venv312`, since the pinned versions target Python 3.12) found the claim's *spirit* was right even
though the tracking wasn't real: `transformers==4.57.6` has three real advisories, two of them
critical RCE:

- **PYSEC-2025-217 / CVE-2025-14929** — RCE via the X-CLIP checkpoint-conversion script's unsafe
  deserialization. No fix version listed upstream.
- **CVE-2026-1839 / GHSA-69w3-r845-3855** — RCE via `Trainer._load_rng_state()` calling
  `torch.load()` without `weights_only=True`. Fixed in `transformers` 5.0.0rc3.
- **CVE-2026-4372 / GHSA-29pf-2h5f-8g72** (critical) — RCE via a malicious `config.json`'s
  `_attn_implementation_internal` field, causing `from_pretrained()` to download and execute
  arbitrary code from an attacker-controlled Hub repo. Bypasses `trust_remote_code`. Fixed in
  `transformers` 5.3.0.

**Reachability in this codebase, verified by reading the actual code (not assumed):**
`services/tajweed-neural` never imports or uses `Trainer` (`grep -rn "Trainer" *.py vendor/*.py`
— zero matches), so CVE-2026-1839 is not reachable here. The X-CLIP conversion script
(PYSEC-2025-217) is unrelated to this service's Wav2Vec2Bert model and is never invoked.
CVE-2026-4372's exploitation path is the live one: every `from_pretrained()` call in
`model_loader.py`/`vendor/multi_level_tokenizer.py` uses `model_id`, which resolves to
`MODEL_ID = os.environ.get("TAJWEED_NEURAL_MODEL", "obadx/muaalem-model-v3")` — a
server-configured deploy-time value, never attacker/request input. The realistic exposure is a
supply-chain one (the specific pinned Hub repo, `obadx/muaalem-model-v3`, being compromised
upstream), not a per-request vulnerability an external caller can trigger through this service's
own API surface. Combined with `services/tajweed-neural` already being documented as
**EXPERIMENTAL and off by default** (see its own `server.py` module docstring — the learner path
uses the reviewed rule-based tajweed engine, not this model), the risk is real but currently
narrow.

**Decision.** Track this honestly instead of the prior false claim. Fixed the `docker-compose.yml`
comment to point at this ADR. Do NOT bump `transformers` to `>=5.3.0` in this pass: it is a major
version jump against a vendored, third-party custom model class
(`Wav2Vec2BertForMultilevelCTC`/`MultiLevelTokenizer` under `vendor/`, from
github.com/obadx/prepare-quran-dataset) that this session cannot safety-test without the real
model weights and a from-scratch inference run — a blind major-version bump risks silently
breaking model loading rather than fixing anything, for a service that is not currently reachable
in production. Upgrading to `transformers>=5.3.0` (and re-vendoring/re-testing the custom model
class against the new API) should be a required precondition before `tajweed-neural` is ever
promoted out of "experimental, off by default."

**Consequences.** `services/tajweed-neural/requirements.lock.txt` still pins the vulnerable
version; this ADR is the source of truth for that decision until the service is promoted to
production, at which point the upgrade above is mandatory, not optional. `services/asr-inference`
does not import `transformers` at all in its current Dockerfile build (see the same
`docker-compose.yml` comment thread) so is unaffected regardless.

## ADR-0015 — Word-level audio timings via Quran.com v4, deterministically mapped to canonical words

**Status:** Accepted · **Date:** 2026-07-15 · **Deciders:** owner (data provenance)

### Context
Real-time word-by-word follow-along (Tarteel's signature feature) needs per-word audio timings.
None existed in the repo; `persistSessionAlignments` shipped `startMs:0/endMs:0`. Inventing
millisecond timings is fabrication and forbidden. Real, matched timing data is available openly.

### Decision
Ingest word-level segment timings from **api.quran.com v4** (`verses/by_key/{key}?audio=7`,
Al-Afasy) as static, checksummed JSON in `packages/quran-data`. The audio master is Quran.com's own
(`verses.quran.com`), so timings and playback audio are matched by construction — no cross-master
drift. Playback for timed surahs moves from the islamic.network CDN to the Quran.com master.

Our canonical word segmentation does **not** match Quran.com's for two DETERMINISTIC reasons:
(1) our ayah 1 of a basmala surah prepends the 4 basmala words; (2) our text tokenizes standalone
waqf marks (e.g. ۛ) as separate words. The ingest normalizes both away and then **requires exact
count parity** before mapping segment→canonical word id; any ayah that still doesn't match, or that
carries a degenerate source segment (`end<=start`, observed at 2:164/2:249), is **excluded and
logged**, never truncated or guessed. Basmala/waqf tokens simply carry no timing.

### Options considered
- **A. Quran.com v4 API + strict alignment (chosen).** Open data, matched master, deterministic
  mapping, verified against canonical text. Coverage 340/344 pilot ayahs (99%).
- **B. Graft QUL timings onto the existing islamic.network audio.** Rejected: different masters →
  systematic drift; timings measured against one encode don't hold on another.
- **C. Adopt Quran.com word keys as our canonical segmentation.** The proper long-term fix (audit's
  data-layer recommendation) but a larger migration; deferred. This ADR maps onto our existing ids.

### Consequences
- Easier: follow-along highlight (T2), and any future per-word audio evidence.
- Harder / follow-ups: ayah-1 basmala words and standalone waqf marks are intentionally un-timed
  (won't highlight); the 4 excluded pilot ayahs need Quran.com word-key adoption (option C) to
  recover. Commercial launch must confirm the specific reciter resource's license on QUL
  (see docs/DATA_LICENSES.md#quran-com-word-segments-audio).

## ADR-0016 — Sorani (Kurdish) ayah translations via Quran.com/QuranEnc, rendered verbatim

**Status:** Accepted · **Date:** 2026-07-15 · **Deciders:** owner (content provenance)

### Context
The app's default language is Central Kurdish (Sorani, `ckb`) but it shipped ZERO translated verse
content — a Kurdistan learner read an English UI over Arabic they may not understand. This is the
core of the "#1 for Kurdish speakers" strategy (ROAD_TO_1 T4). Fabricating Quran translation is
forbidden; a licensed Sorani translation exists as open data.

### Decision
Ingest translation id 81 (**Burhan Muhammad-Amin / Tafsiri Asan**, the default Kurdish on
Quran.com, from the QuranEnc ecosystem) from api.quran.com v4 as static JSON in packages/quran-data,
and display it under each ayah in the reader (RTL, `lang="ckb"`), toggleable, default-on when the
app language is `ckb`. Text is stored and rendered **verbatim** — QuranEnc's license forbids any
modification. Ayahs the source has no entry for (e.g. 108:3, which Quran.com 404s) are recorded as
missing and render nothing — never invented.

### Options considered
- **A. Quran.com v4 id 81 (chosen).** Live, licensed, the region's default reading, 339/340 pilot
  ayahs. Attribution + verbatim storage satisfy the license.
- **B. QuranEnc bulk JSON dumps.** Same underlying text; heavier ingest, no per-ayah API. A valid
  alternate if the API is unavailable.
- **C. Machine translation.** Rejected outright — fabrication of religious content.

### Consequences
- Easier: Kurdish learners get meaning; sets the pattern for Arabic/other translations (add a slug).
- Follow-ups (docs/DATA_LICENSES.md#ckb-sorani-translation): confirm the QuranEnc **version string**
  and schedule periodic re-fetch (the license's continuing-update duty); Quran.com's API exposes no
  version field, so `fetchedAt` is only a drift anchor. Native-speaker review of the *UI strings*
  (ckb bundle) remains T5 — this ADR covers verse translations only.

## ADR-0017 — /v1/force-align is a real CTC forced aligner (T3), replacing Whisper-prompt bias

**Status:** Accepted · **Date:** 2026-07-16 · **Deciders:** owner (new model dependency)

### Context
`/v1/force-align` was dead code that used Whisper's `initial_prompt` to *bias* decoding — it did not
guarantee word-for-word correspondence with the canonical text, so it could not produce trustworthy
per-word timestamps (T3). The learner path still persisted `startMs:0/endMs:0`.

### Decision
Reimplement `/v1/force-align` as true CTC forced alignment: `torchaudio.functional.forced_align`
against an **Apache-2.0** Arabic model (`jonatasgrosman/wav2vec2-large-xlsr-53-arabic`, overridable
via `FORCE_ALIGN_MODEL`) on the diacritic-stripped canonical characters, so response word *i* IS
transcript word *i*. Logic lives in `services/asr-inference/forced_align.py`; the alignment model
loads lazily on first call (separate from the ASR model) so the service boots unchanged.

Validated: `forced_align_arabic.py` imports the exact shipped `align_words` and checks it against
Quran.com ground truth — mean word-START error ~64-100 ms over Al-Fatihah 1:1-1:3 -> PASS.

### Consequences
- New dependency: **`transformers`** (Apache-2.0), NOT yet in `requirements.lock.txt` — the endpoint
  lazy-imports it and returns 500 if absent (other endpoints unaffected). Before deploying force-
  align, regenerate the lock per its header (add `transformers`) and re-run pip-audit. Until then
  the aligner runs from the service venv (where it was validated).
- Remaining T3 wiring (separate PRs): ml-inference threads timing into the alignment response ->
  Rust persists non-zero start_ms/end_ms -> web sends audioBase64. Last-word END drifts into
  trailing silence (measure madd separately).

## ADR-0019 — Interface locale capability gates prevent untranslated UI claims

**Status:** Accepted through the 2026-07-19 readiness-recovery plan
**Deciders:** product owner (approved recovery plan), implementation team

### Context

The web catalog declared Arabic `live` and Sorani `pilot` while
`apps/web/src/locales/` contained only English. The application correctly fell
back to English rather than fabricating religious-education copy, but it still
offered those locales to real users and flipped the document to RTL. That is not
a usable Arabic or Sorani interface. Separately, the reader has bounded,
verbatim Sorani verse translations; this is source content, not proof that
controls, consent, privacy, feedback, and errors are translated.

### Decision

Use the `localeCapabilities` registry as the one policy source for language
selection. A normal user can select only a locale with a recorded interface
capability. A source-language bundle records its path and key count; a future
translated bundle must also record full-key coverage, native reviewer, review
date, and review expiry. The normal selector and `?lng=` input resolve unavailable locales
to English. Test and smoke mode may enumerate the catalog only to exercise
fallback/direction regressions; that exception must not reach user builds.

Until reviewed packs exist, English is the only offered interface. Sorani verse
material remains a separately bounded, attributed capability and must not be
marketed as a Sorani UI.

### Consequences

- The product stops misrepresenting an English fallback as live/pilot Arabic or
  Sorani interface support.
- A product decision and explicit source/coverage labelling are required before
  exposing a bounded verse-translation control independently of the interface.
- The registry is a local truthfulness guard, not R5 proof. Native-language,
  Quran-content, RTL/accessibility, and candidate-bound review evidence are
  still required before a non-English interface can return.

## ADR-0021 — Agent-run dedup is application-level, not a DB unique constraint (for now)
**Date:** 2026-07-08 · **Status:** Accepted

**Context.** The Tajweed Explainer batch re-recorded every finding on every tick, growing
`agent_runs` unboundedly and spamming the teacher review queue with duplicates. The obvious fix
is a DB unique constraint on `(tenant_id, finding_id)` — but `finding_id` lives inside the
`trace` JSONB, not a column, so that needs a new migration. New migrations currently can't ship
green: CI's Postgres only applies `infra/migrations/0001–0013` (its list in the CI-protected
`.github/workflows/ci.yml`), so any integration test touching a new column fails `verify` — the
exact wall that's kept PR #123 red since 2026-07-07.

**Decision.** Dedup at the application layer instead (PR #193): `list_agent_runs` surfaces
`findingId` from the *existing* `trace` JSONB (no migration), and the batch skips findings that
already have a run. Sufficient because batches are sequential cron ticks, not concurrent.

**Options.** (A) DB unique constraint — bulletproof against concurrency, but blocked on the
`ci.yml` migration-list unblock. (B) App-level skip — ships now, CI-green, no schema change; not
atomic against two concurrent batch runs.

**Consequences.** Duplicates stop today. When the owner adds `0015–0020` (+#123's `0018`) to
`ci.yml`, promote to Option A in the same batch: migration adds an indexed `finding_id` column +
partial unique index, and `create_agent_run` uses `ON CONFLICT DO NOTHING`. Until then, a
hypothetical concurrent double-run could still double-record — acceptable for a single-tenant
cron pilot.

---

**Renumbered 2026-07-29 (was ADR-0013).** ADR-0013 on `main` is a different decision — release
gating of the mushaddad ghunnah limitation — so this one was a number collision, which is why the
PR could never merge cleanly. Content is unchanged apart from the number and this note.

**Status update 2026-07-29 — the constraint this ADR was written around is gone.** Two of its
premises no longer hold: CI now applies migrations `0001–0021` (not `0001–0013`), and PR #123 was
closed as obsolete because the agent-run erasure fix had already landed on `main` by another path
(`0018_agent_run_learner_id.sql` + `privacy.rs:356` + `privacy_delete_erases_learner_agent_runs`).
So the "blocked on the ci.yml migration list" reason for choosing Option B has expired, and Option A
(the DB unique constraint) is now shippable whenever the owner wants it. The app-level dedup remains
correct and in place; this is no longer a forced choice, just an unpromoted one.

## ADR-0022 — Deployable artifacts must be immutable and digest-pinned, so rollback has a target
**Date:** 2026-07-30 · **Status:** Accepted (amended 2026-08-07, option B) · **Deciders:** repo owner + whoever owns ops

**Original context.** `docker-compose.yml` built every application service from source (`build:`); only
`postgres` uses `image:`. No workflow builds or pushes a container image — `grep -i
"docker build|docker push|ghcr|registry|docker/build-push"` across `.github/workflows/` returns
nothing. So there is no artifact anywhere that represents "the version that was running".

Consequently **rollback today means `git checkout <old-sha> && docker compose build`** — a rebuild,
not a rollback. It takes minutes instead of seconds, and it can fail for reasons unrelated to the
code being restored. That is not hypothetical: when GHSA-r28c-9q8g-f849 (postcss) published, `pnpm
audit` failed on every branch including `main` at a commit that had passed CI hours earlier (#261).
A rollback attempted in that window would have failed at the build step, at exactly the moment it
was needed.

The release-evidence machinery already assumes this is solved. `scripts/release-manifest.mjs:179`
defines `assertImageDigests()`, `:241-243` requires build-provenance digests to match the build
summary, and `scripts/release-challenge.mjs:248` forwards `RELEASE_IMAGE_DIGESTS_JSON`. **The
evidence model and the deploy model disagree, and the deploy model is the one that is wrong.**

**Decision.** Deployables become immutable images identified by digest. `docker-compose.yml` gains an
image reference per service, tagged from the git SHA at build time, with the previous tag retained so
there is always a target to return to. `imageDigests` is populated for real, satisfying the manifest
verifier that already demands it rather than relaxing the verifier to match reality.

**Options.**
- **(A) Local tag retention.** Build and tag locally (`qrai/<service>:<git-sha>`), keep the last N.
  No credentials, no network dependency during an incident. But tags live only on the host that
  built them — a replacement host has nothing to roll back to, so it is not disaster recovery.
- **(B) Registry (GHCR).** Push digest-pinned images from CI. Survives host loss, gives a real
  provenance chain, and is what the manifest verifier was designed for. Costs CI credentials and
  makes a rollback depend on registry availability during an incident.
- **(C) Do nothing.** Keep rebuilding. Rejected: it makes P5.5 permanently unprovable, and the
  postcss episode shows the failure mode is real rather than theoretical.

**Recommendation: (B), with (A) as the interim** — (A) is a few lines and makes rollback rehearsable
immediately; (B) is what makes it disaster recovery. Do not let (A) become the resting state.

**Consequences.**
- Rollback becomes `docker compose up -d` against a pinned digest: seconds, and immune to a broken
  build or a moving upstream dependency.
- Everything that drives compose is affected — `docs/STAGING_RUNBOOK.md`, the `scripts/smoke-*.mjs`
  family, `monitoring/docker-compose.monitoring.yml`, and CI if images are built there.
- Under (B), an incident acquires a dependency on the registry being reachable. That trade is
  deliberate and should be stated in the runbook, not discovered during an outage.
- Storage grows with retained tags; a retention count is needed, mirroring `backup-db.sh`'s.

**SUPERSEDED 2026-08-07 — the initial option (A) decision is replaced by option (B), GHCR.**

The W2.18 audit proved that local retention never produced a usable rollback artifact in the actual
workflow: a GitHub-hosted runner is a fresh VM for the job and is decommissioned when the job ends,
so its local Docker tags disappear. The uploaded file also mixed build logs with JSON, and no
Compose path consumed the claimed digests. Those were correctness failures, not future scaling
concerns.

The accepted design is now a **durable registry**:
- CI publishes every deployable artifact to GHCR under the full candidate Git SHA and records the
  registry-reported `sha256` digest in strict machine-readable JSON;
- `node-api`, `job-worker`, and `node-realtime` share one `node-backend` artifact identity because
  they execute the same production image, while the migration runner remains a separate
  least-privileged artifact;
- `docker-compose.release.yml` disables source-build fallback and requires exact
  `repository@sha256:digest` references for every released application service;
- `scripts/release-deployment.mjs` preserves one explicit candidate/previous selection, renders
  either slot into the release overlay, and fails image verification when any running container is
  stopped, substituted, or backed by content other than the selected registry digest;
- rollback selects a previously retained digest. `scripts/http-canary-controller.mjs` reverses Web
  and realtime indexing together, then restores and verifies the seven previous application images;
  it deliberately excludes the one-shot database image because schema rollback is not an
  application incident action. Registry retention/deletion is an explicit remote policy and is
  never simulated by pruning ephemeral runner-local tags.

`docker-build.yml` remains a Dockerfile verification workflow, not release publication. A release
or rollback rehearsal must use the release overlay and observed image digests; rebuilding an old
commit does not satisfy the rollback gate.

**Implementation note (2026-08-08, W2.18 T5 gate; W3.2 service-count amendment):** controller artifacts now distinguish a
healthy observation, a deliberate rollback drill, and an incident, and offline verification
requires the rollback to expose seven restored images, one stored effect, zero duplicates, and passed
privacy cleanup. Release mode validates a fresh signed monitoring observation, the exact successful
remote check inventory, and independent role-bound release-owner/security/SRE Ed25519 approvals
over the exact candidate/load/controller artifacts. The validator writes a closure only after the
full release gate and never promotes traffic or creates a human approval.

**Consequences of the amended decision.** Host loss no longer destroys candidate or prior image
identity, and release evidence matches the deploy path. Rollback does depend on GHCR availability;
the runbook must preserve a previously pulled digest on the deployment host and must never describe
a source rebuild as rollback. P5.5/P5.6 remain open until a real candidate and prior digest are
deployed and the timed rollback drill is evidenced.

---

## ADR-0023 — Node tests talk to Postgres through `pg`, not a `psql` subprocess
**Date:** 2026-07-31 · **Status:** Accepted (Phase 6, `specs/api-parity-suite/plan.md` §7) · **Deciders:** repo owner

**Context.** Phase 6 adds a black-box `node:test` suite that must assert on database state — 23 of
the 77 Rust integration tests do (`specs/api-parity-suite/research.md §3`), and those are exactly the
assertions the Phase 5 fixture differ structurally cannot make, because it only sees HTTP responses.

Before this ADR there was **no Postgres driver in the repository**: `grep -rn '"pg"'
--include=package.json .` returned nothing. Node reached the database by shelling out to `psql`
(`scripts/smoke-sql.mjs:162`, with a `PSQL` path override at `:414`).

**Decision.** Add `pg` (node-postgres) as a **root devDependency**. All database access in the parity
suite goes through a single `queryJson()` function in `tests/api-parity/lib/harness.mjs`.

**Why not the `psql` subprocess, which needs no new dependency.** `psql` is not guaranteed to be on
PATH — verified absent on the maintainer's own machine while planning this phase, though present in
CI via the `postgres:16-alpine` service. A suite that depends on it would **silently skip** where it
is missing. That is the skip-if-missing anti-pattern MIG5 rejected in as many words: *"a soft skip
would report green on a machine with no Python and hide exactly the class of bug this exists to
catch."* A test suite whose security assertions vanish on some machines is worse than one that isn't
written, because the gate still prints green.

Secondary: Phase 7's Node backend needs a Postgres driver regardless. Choosing one now, while the
blast radius is test-only, is cheaper than choosing it under delivery pressure.

**Consequences.**
- `pg` enters the `pnpm audit` supply-chain gate (P4.4). Checked at adoption: `pnpm audit
  --audit-level moderate` → *No known vulnerabilities found*. It is a mainstream, low-churn package,
  but this is a real new surface, not a free one.
- **dev-only.** It must not become a runtime dependency of any shipped artifact without a new ADR.
  The Rust services keep using `sqlx`; nothing in `apps/web` imports it.
- Reversible for one file's cost: `queryJson()` is the only place the driver is named. If a future
  constraint forbids the dependency, that function is rewritten to shell out to `psql` and the 26
  tests are untouched — but the skip-vs-fail rule above must then be enforced explicitly.
- This ADR takes **no position** on which driver Phase 7's backend should use for production traffic
  (pooling, prepared statements, and RLS transaction pinning are different requirements). That is a
  separate decision on its own evidence.

## ADR-0024 — One security switch becomes six named ones; the blunt name survives as a deprecated alias

**Status:** Accepted (2026-08-01). **Context:** `specs/insecure-defaults-split/` ·
supersedes the unimplemented `specs/flutter-node-migration/plan.md §2.6`.

**Context.** `ALLOW_INSECURE_DEFAULTS` disabled **six independent controls** across two services
through **seven read sites** and thirteen assertions: every secret-strength boot panic, the
superuser/`BYPASSRLS` DB-role assertion, `/metrics` fail-closed in both services, the entire CSWSH
`Origin` allowlist, its missing-`Origin` fail-closed branch, and chaos fault injection.

The operational pressure is specific and imminent. A native/Flutter client sends **no `Origin`
header**, and the gateway fails closed on that. "Mobile can't connect" leads an operator to the one
variable that also ships a known-public JWT signing key, a DB role that makes all 16 RLS policies
inert, an internet-reachable `/metrics`, and a gateway that will drop sockets on command.

**Decision.** Split into `ALLOW_INSECURE_SECRETS`, `ALLOW_SUPERUSER_DB_ROLE`, `METRICS_DEV_OPEN`,
`GATEWAY_ALLOW_MISSING_ORIGIN` and `ALLOW_CHAOS_INJECTION`. Keep `ALLOW_INSECURE_DEFAULTS` as a
working alias that relaxes everything, with a loud boot warning and a **refusal to start** if it is
set alongside any per-control variable.

**The load-bearing part is narrower than a rename.** `GATEWAY_ALLOW_MISSING_ORIGIN` relaxes *only*
the missing-`Origin` branch: a request that carries an `Origin` is still checked against the
allowlist. A native deployment gets exactly the relaxation it needs and **browsers keep their CSWSH
protection**. Disabling the allowlist outright has no legitimate deployment, so it stays reachable
only through the deprecated name. Pinned by
`realtime-gateway/src/lib.rs::missing_origin_knob_does_not_disable_the_allowlist`, whose second
assertion is that a disallowed origin is still 403.

**Rejected: inventing `APP_ENV` so the alias could panic in production.** §2.6 asked for "a boot
assertion that it is never set in production". Neither service knows what environment it is in, and
adding a variable to find out is the same mistake in a new costume — plus a service that panics
because `APP_ENV` was forgotten is a new outage mode. Instead:
`tests/security/legacy-insecure-flag.test.mjs` fails the build if a committed production artifact
ships a relaxation switched on. **That is strictly weaker** — it cannot catch an operator exporting
the variable by hand — and both `insecure.rs` modules say so in place rather than implying coverage
they do not have.

**Rejected: fixing the `"1"`/`"true"` asymmetry.** `platform-api/src/lib.rs` accepted `"1"` alone at
the `/metrics` gate while every other site accepted `"1"` or `"true"`, so
`ALLOW_INSECURE_DEFAULTS=true` skipped the boot checks and still left `/metrics` closed.
`tests/api-parity/metrics.test.mjs` **depends** on that combination. The asymmetry is carried forward
verbatim **inside the deprecated alias only**; the new names are consistent everywhere. The parity
suite therefore passes **unchanged**, which is the sharpest available evidence that backwards
compatibility actually held.

**Consequences.**
- Two hand-maintained copies of a ~25-line resolver (`services/*/src/insecure.rs`). A workspace crate
  for that buys a dependency edge and nothing else; `shared-ticket` exists because a *wire format*
  must not diverge, which this is not. The copies genuinely differ, and a test asserts they agree on
  the alias name.
- `ALLOW_INSECURE_DEFAULTS` still works, so this **reduces the pressure** to reach for the blunt
  instrument without removing it. Removal is a separate breaking change and needs its own ADR.
- Setting the old and new variables together is now a **boot failure**, not a merge. Any deploy doing
  both must pick one.

## ADR-0025 — The Node port needs a bcrypt implementation, and there is no way around it

**Status:** Proposed (2026-08-01). **Context:** `specs/migration-completion/` N12b.

**Context.** `POST /v1/auth/register` and `POST /v1/auth/login` are the last two routes in the
approved port that cannot be written with what this repo already has. `register` writes
`bcrypt::hash(password, 12)` and `login` verifies against that stored hash
(`services/platform-api/src/handlers/user.rs:89,179`). Both implementations must accept each
other's hashes for the whole strangler period — a learner who registers against Rust must be able
to log in against Node on the very next request, and the reverse.

The ladder was walked before proposing a dependency, and every rung fails:

| rung | verdict |
|---|---|
| Does it need to exist? | Yes. `login` cannot verify a stored bcrypt hash without bcrypt. |
| Already in this repo? | No. `jose` (JWT), `postgres`, `pg`, `fastify`, `ajv`, `zod`, `yaml`. |
| `node:crypto`? | **No bcrypt.** `scrypt`, `pbkdf2` and `hkdf` are present and are different KDFs producing incompatible hashes. |
| A few lines of our own? | **Absolutely not.** bcrypt is Blowfish with a modified key schedule; a hand-rolled version is the canonical example of a security primitive nobody should write. |

**Decision.** Add ONE new runtime dependency to the Node service for bcrypt.

**Options.**

| | `bcryptjs` | `bcrypt` (node.bcrypt.js) |
|---|---|---|
| Install | pure JS, no compiler, no `node-gyp` | native addon, needs a toolchain per platform |
| Speed | ~3× slower than native at cost 12 | faster |
| CI/container risk | none | a prebuilt-binary miss turns into a source build inside the image |
| Supply chain | one package, no install scripts | native build scripts run at install |

**Recommendation: `bcryptjs`.** Cost 12 is *deliberately* expensive — hundreds of milliseconds by
design — so the constant factor between the two is small relative to the work bcrypt is doing on
purpose. In exchange the container stops needing a build toolchain and the install stops running
scripts. The Rust handler already moves hashing to `spawn_blocking` because it is CPU-bound; the
Node port needs the equivalent care regardless of which library is chosen, since a synchronous
hash at cost 12 blocks the event loop for the whole service.

**Consequences.**
- Easier: `register`/`login` become portable, which is the last blocker on N12.
- Harder: one more thing to audit, and `pnpm audit` gains a package that handles credentials.
- To revisit: if the platform ever ships a bcrypt primitive, or if the product moves to Argon2id —
  which would be a *better* password hash but is a migration of every stored credential, not a
  swap, and is out of scope for a port whose entire contract is behavioural identity.

**Not decided here.** Whether to keep bcrypt at all. Argon2id is the modern recommendation, but
changing the KDF is a data migration with a rehash-on-next-login path and its own spec. A port must
not quietly change how credentials are stored.

**Action items.**
1. [ ] Owner accepts or rejects this ADR (a new runtime dependency handling credentials).
2. [ ] If accepted: add `bcryptjs`, port `register`/`login`, and prove interoperability with
       cross-language vectors generated **from Rust** — Rust-hashed passwords verified in Node and
       Node-hashed passwords verified in Rust. A same-implementation round trip proves nothing.
3. [ ] Hash off the event loop, and assert it.

---

## ADR-0026 — The Flutter client needs a microphone and a socket, and neither is in the SDK

**Status:** Accepted (2026-08-02, on the owner's instruction to build the app)
**Deciders:** repository owner
**Supersedes / superseded by:** none

### Context

The 2026-08-01 audit found `apps/flutter` was eight library files: no entry point, no host projects,
**no recorder and no WebSocket**. `FL5` had shipped a consent gate over an `AudioRecorder` interface
with no implementation behind it, which is why the gate could be tested and the app could not run.

The owner reviewed that finding and instructed the work to proceed, in a message that named the
recorder and the WebSocket explicitly. AGENTS.md requires an ADR for a new runtime dependency; this
records what was added and why, so the choice is reversible by argument rather than by archaeology.

### Decision

Two runtime dependencies in `apps/flutter/pubspec.yaml`:

| package | version | what it does | why not the SDK |
|---|---|---|---|
| `record` | 7.1.1 | PCM16 microphone capture via `startStream` | Flutter has **no** microphone API. There is no stdlib alternative at any rung of the ladder. |
| `web_socket_channel` | 3.0.3 | cross-platform WebSocket | `dart:io`'s `WebSocket` would cost zero dependencies but **does not exist on web**, and web is currently the only target this machine can run and screenshot (`research.md §1`: no Xcode, no Android cmdline-tools). |

`web_socket_channel` is the weaker of the two justifications and is written down as such: on a
machine with Xcode it would be a genuine choice rather than a forced one.

### Options considered

**(A) Both dependencies — chosen.** The app runs on the one target available here, and the same
code path serves iOS and Android unchanged.

**(B) `record` + `dart:io` WebSocket.** One dependency instead of two, but no web build — so the
only proof available on this machine would be `flutter test`, which is exactly the "components, not
a client" state the audit objected to. Rejected because it would have made the fix unverifiable.

**(C) Neither — keep the interface, ship no implementation.** This is the status quo the audit
called a P0. Rejected.

### Consequences

- **Easier:** the practice flow exists and runs; `streaming_recorder_test.dart` drives the whole
  transport with an injected socket and PCM stream, so ordering is asserted without a microphone.
- **Harder:** two more packages in the supply-chain surface, both with platform channels. Neither is
  reachable from `services/`, so the API attack surface is unchanged.
- **Revisit if:** iOS/Android become the only shipped targets. Then (B) drops
  `web_socket_channel` for `dart:io` at the cost of the web build.

### What this ADR does NOT decide

Whether the Flutter client replaces `apps/mobile` (Expo). It does not: both exist, and the owner has
not been asked. `FL9` — the device matrix — remains open and is not satisfied by a web build.

### Action items

1. [x] Add both packages, with the versions pinned in `pubspec.lock`.
2. [x] Assert transport ORDER without hardware: socket before microphone, and no microphone at all
       when the gateway refuses the ticket.
3. [ ] Re-evaluate `web_socket_channel` when a machine with Xcode is available.

---

## ADR-0027 — A teacher's decision changes the finding, so the review queue is not a dead end

**Status:** Accepted (2026-08-02, on the owner's instruction — "wire it")
**Deciders:** repository owner
**Supersedes / superseded by:** none

### Context

`create_teacher_review` recorded a decision in `teacher_reviews`, wrote an audit event, and stopped.
Nothing in the platform ever updated `tajweed_findings.review_status` — verified by
`grep -rn "UPDATE tajweed_findings" services/platform-api/src`, which returned nothing, and there
was no database trigger either.

The consequence was total and silent. `canShowLearnerFacingAiOutput` admits only `teacher-reviewed`
and `scholar-approved`. `services/ml-inference` stamps every finding `ai-suggested`. So **no finding
could ever become learner-visible by any path**: a teacher could accept every item in the queue,
every evening, and no learner would see anything change. `docs/readiness/TRUE_READINESS.md` recorded
the symptom ("a learner gets the *scaffold*, not the *coach*") without naming the missing write.

Building the Flutter review queue (`apps/flutter/lib/src/review/`) forced the question, because a
review console whose decisions provably reach nobody is a facade.

### Decision

`create_teacher_review` promotes the finding in the **same transaction** as the review row and the
audit event, in both implementations (`handlers/review.rs` and `node-api/routes/review.mjs`):

| decision | `tajweed_findings.review_status` becomes | why |
|---|---|---|
| `accepted` | `teacher-reviewed` | the status the learner gate already admits |
| `rejected` | `blocked` | an explicit refusal, distinguishable from "not looked at yet" |
| `edited` | **unchanged** | see below |

`edited` promotes nothing. It means the teacher rewrote the explanation, and there is nowhere to put
the rewrite: `teacher_reviews.note` is free text that no reader folds back into the finding.
Promoting would publish the ORIGINAL wording as teacher-approved — precisely the text the teacher
said was wrong. The finding stays pending and stays in the queue, which is the truth about it.

One transaction, deliberately: a promotion without its audit trail is learner-facing content nobody
can account for, and a review row whose promotion was lost is a teacher's decision silently dropped.
Either half alone is worse than neither.

### What this decision actually means

**One teacher's acceptance is now sufficient to show AI-generated feedback about a person's
recitation of the Qur'an.** That is the substance of this ADR, not the SQL. It was the owner's call
and it is recorded here so it can be revisited by argument.

The other three requirements are unchanged and still enforced: a promoted finding is shown only if
it also carries at least one source and clears the 0.82 confidence floor
(`canShowLearnerFacingAiOutput`, mirrored in `apps/flutter/lib/src/api/models.dart` and pinned by
`tests/contract/tajweed-gate-parity.test.mjs`). Promotion is necessary, not sufficient.

### Consequences

- The teacher half of the loop closes: a decision now reaches the finding and changes its status.

**Both missing links are now closed** (2026-08-02, same day, on the owner's instruction "do both"):

1. **Findings are persisted.** `proxy_ml` writes them after a tajweed prediction
   (`ml_proxy.rs::persist_tajweed_findings`). Three constraints shape it: a finding must anchor to a
   real `word_alignments` row (fabricating one would invent `heardText`/`startMs` for audio nobody
   aligned, so unanchorable findings are skipped and counted); it writes **once per session**,
   because `persist_session_alignments` cascades `teacher_reviews` away on re-write and a learner
   tapping stop twice must not destroy a teacher's completed review; and the tajweed model is
   resolved by `kind` rather than from the response, which reports `ml-aligner-v0.2` — an
   *alignment* model, and not a `model_versions` row at all.
2. **The learner can read them.** `GET /v1/recitation-sessions/{id}/tajweed-findings`, scoped by
   `require_self_or_any(learner_id, [Teacher, Admin, Ops])` — ownership, not role. It returns
   withheld findings too, with their status, so the client can distinguish "3 notes are waiting for
   a teacher" from "no feedback"; `canShowLearnerFacingAiOutput` still decides what is displayed.

`tajweed_findings_persist_and_the_learner_can_read_their_own` drives the whole chain against live
Postgres: analyse → persist → teacher accepts → the learner reads it back as `teacher-reviewed`,
satisfying every term of the gate.

The chain needs alignments, and the Flutter practice flow produced none — it streams to the realtime
gateway, which forwarded audio chunks and computed nothing. Closed the same day by action item 5:
the gateway's audio is transcribed where it lands (`ml-inference /v1/session-transcript`) and
`POST /v1/recitation-sessions/{id}/finalize` derives and persists the alignment server-side, without
letting the client say what the learner recited.

**What remains unproven.** The whole chain has only ever run against a MOCKED ASR. Assembly,
ordering, session scoping and the consent refusal are covered
(`services/ml-inference/session-transcript.test.mjs`), but the accuracy of a real Whisper transcript
— and whether the alignment it yields is fair to a learner — has not been measured. That needs the
real service and someone who can judge Quranic recitation; it is not a test this repo can write.

### Action items

1. [x] Promote in `handlers/review.rs`, in the existing transaction.
2. [x] Mirror in `node-api/routes/review.mjs`; the parity suite keeps the two honest.
3. [x] Integration coverage against live Postgres for all three decisions, including that `edited`
       changes nothing and that a promoted finding then passes the learner gate.
4. [x] Persist computed tajweed findings, and give a learner a route that reads their own session's
       persisted findings. Both landed 2026-08-02; the chain is covered end to end against live
       Postgres.
5. [x] Give the Flutter practice flow an alignment step, or have the gateway produce alignments.
       Done 2026-08-02 as the latter, on the owner's instruction. The gateway's audio is transcribed
       where it already lands (`ml-inference /v1/session-transcript`) and
       `POST /v1/recitation-sessions/{id}/finalize` derives and persists the alignment server-side.
       The client supplies nothing about what was said — whoever supplies the recognised words
       decides what the learner is recorded as having recited.
6. [x] Decide whether teacher acceptance should refuse a sourceless finding, as scholar approval
       does. Done 2026-08-02, on the owner's instruction: it refuses, in both implementations,
       BEFORE any write — so a refused acceptance leaves no row and no audit trail implying one was
       considered. Only `accepted` is refused; rejecting or editing an unsourced finding is what a
       teacher should be able to do with one, and refusing those would trap it in the queue. The
       Flutter review card disables Accept for the same case rather than letting a teacher spend
       judgement on a 400.

---

## ADR-0028 — The learner gate is enforced on the wire, not in the client

**Status:** Accepted
**Date:** 2026-08-02
**Context:** readiness-recovery-10-10 P3.2 (withheld-feedback and provenance tests)

### Context

The platform rule is that no AI judgement about someone's recitation reaches them before a human
approves it, with a source and enough confidence. That rule had four implementations — TypeScript
(`canShowLearnerFacingAiOutput`), Dart (`isLearnerVisible`), and two Rust/Node copies for agent runs
— and `tests/contract/tajweed-gate-parity.test.mjs` kept the first two honest with each other.

Every one of them was a **client-side filter**. Both learner-facing routes returned unreviewed
findings in full — `rule`, `severity`, `explanation`, `wordId`, `confidence`, `sources` — and relied
on the browser or the app to hide them:

- `GET /v1/recitation-sessions/{id}/tajweed-findings`
- `POST /v1/ml/tajweed-findings:predict` — where *everything* is `ai-suggested` by construction

The route's own doc comment defended this: "a COUNT of pending notes is not a judgement about the
recitation". The argument is right. The code did not implement it — it shipped the judgement and
counted on the UI not to render it. `curl` with the learner's own token read all of it, and so would
any client that forgot the rule. This is the same shape as ADR-0027 item 6, found the same way.

### Decision

Both routes redact server-side for a learner. A finding that does not clear the gate **keeps its row
and its `reviewStatus`** and loses everything that is a judgement: `rule`, `severity`, `explanation`
and `wordId` become empty, `confidence` becomes `0`, `sources` becomes `[]`, and `withheld` is
`true`. Staff receive every finding intact — reviewing the unreviewed ones is the entire job.

Three things fall out of that shape:

1. **The count survives.** Both clients render "N notes are waiting for a teacher" from the array
   length (`hasWithheldFindings` in apps/web, the `isLearnerVisible` filter in apps/flutter). Neither
   needed changing.
2. **The redacted values fail the client gate on their own merits.** `confidence: 0` and
   `sources: []` are not placeholders — a client that has never heard of `withheld` still cannot
   display one as feedback. The two gates cannot disagree about a redacted row.
3. **`withheld` means the same thing to both audiences** — "not learner-visible" — so staff read it
   as "still pending" rather than needing a second field.

Each route's staff list is a single constant used for BOTH the authorization check and the redaction
decision (`STAFF` in review.rs, `ANALYSIS_STAFF` in ml_proxy.rs). Two copies would drift, and the
direction they would drift in is a learner reading an unreviewed judgement.

`ANALYSIS_STAFF` is admin/ops and deliberately excludes teachers: `proxy_ml` never allowed a teacher
to re-run the analyser against someone's session, and unifying the lists surfaced that a redaction
branch written for `Teacher` was unreachable.

### Consequences

**Easier:** the rule is now enforced where it can be relied on. A new client — a script, a partner
integration, a future native app — gets the safe behaviour without knowing the rule exists.

**Harder:** four implementations became six. `tests/contract/tajweed-gate-parity.test.mjs` now pins
the confidence floor across every one of them, recognising a gate by its provenance check following
the floor, so all six read the same way. Writing a seventh in a different shape fails the test.

**Newly proven:** `PARITY_THROUGH_SHELL=1` has existed since Phase 7 N2 and **no gate had ever run
it** — every gate exercised the Rust binary, so a Node handler could disagree with its Rust original
in any way and stay green. `verify.sh` now runs the ML-proxy parity suite through the Node port, and
the mirror was confirmed by disabling it and watching the suite go red.

### What this does NOT fix

- **`POST /v1/ml/tajweed-findings:predict` analyses CANONICAL text, not the learner's audio.**
  `predictTajweed` calls `getCanonicalWords(...)` and runs rule detection over the Quran passage. It
  inspects no audio, no heard text, no pitch and no timing. What it returns is "rules that apply to
  this passage", presented as findings about a recitation. Redaction makes the *withholding* honest;
  it does not make the *feature* honest. That is P3.4–P3.6 and a scholar's call, not an engineering
  one.
- **The web client still submits a learner-controlled transcript** (`recognizedText` in
  apps/web/src/App.tsx) which becomes persisted alignments and measured progress. The Flutter path
  derives it server-side; the web path does not.
- **The gateway does not forward `audioRetention`** to ml-inference, so a "teacher review" or
  "training opt-in" choice is not honoured downstream. — **FIXED, see ADR-0029.**

All three were found while closing this and are recorded here rather than fixed here, because each
is a product or architectural decision rather than a bug with an obvious right answer.

---

## ADR-0029 — The consent screen's retention question needed an answer nothing downstream could hear

**Status:** Accepted · **Date:** 2026-08-03 · **Supersedes:** the third open item under ADR-0028

### Context

`consent_records.audio_retention` has been a three-value column since the first migration — `discard`,
`teacher-review`, `training-opt-in` — and ml-inference has honoured all three since it was written:
its eviction sweep keeps `training-opt-in` indefinitely, `teacher-review` for seven days, and
everything else for one hour.

The two halves were never connected. The realtime gateway, which is what actually posts a learner's
audio to `POST /v1/audio-chunks`, holds no database and had no way to know the answer. So it sent a
body with no `audioRetention` field at all, ml-inference read `requestBody.audioRetention ?? "discard"`,
and every chunk from every session was labelled `discard` and deleted an hour later.

Nothing was logged, no test failed, and no code was wrong in isolation. The consent screen asked the
question, the database stored the answer, ml-inference was ready to act on it, and the answer never
crossed the gap between them. A learner who chose to keep a recitation for their teacher found it
gone; their teacher found nothing.

### Decision

Put the retention choice in the realtime ticket, and bump the ticket format `rt_v1` → `rt_v2`.

```
rt_v2.{session}.{tenant}.{learner}.{externalAsr}.{audioRetention}.{expiry}.{nonce}.{hmac}
```

The ticket is the only channel from platform-api to the gateway, and it is already HMAC-signed, which
is a requirement rather than a convenience: retention is a field a client would want to rewrite.
Upgrading `discard` to `training-opt-in` on an unsigned field would keep a child's voice forever.

`platform-api` joins `consent_records` when minting and signs the STORED value. The request body has
no say — the same rule `externalAsrProcessing` has always followed, for the same reason.

### Options considered

| Option | Why not |
|---|---|
| Give the gateway a database connection | A second service reading `consent_records` doubles the RLS surface and adds a per-chunk query to the hot path, to learn something already known at ticket time. |
| Have ml-inference look retention up itself | It has no tenant context and no Postgres; it would need both, and a chunk POST would become a cross-service round trip. |
| Send it unsigned as a header | A client-controllable retention field is a privacy hole, not a shortcut. |
| Add a fourth copy of the enum in shared-ticket | `tests/contract/enum-parity.test.mjs` exists because these sets drift. The ticket carries the value as an opaque non-blank string; the closed set stays owned by the DB CHECK constraint, and an unrecognised value degrades to `discard` — shortening retention, never extending it. |

### Consequences

- **A two-service deploy.** Field count went 8 → 9, so v1 and v2 tickets are mutually unparseable in
  both directions — the version tag makes that legible in a log instead of looking like corruption.
  Tickets live 300s, so a rolling deploy costs at most one TTL of refused upgrades; the client
  re-mints and reconnects. Deploy platform-api and realtime-gateway together.
- The six cross-language golden vectors were regenerated **from Rust** and now cover all three
  retention values. The generator is committed at `services/shared-ticket/tests/regenerate_vectors.rs`
  rather than thrown away, `#[ignore]`d so it never runs in CI.
- Two hand-rolled copies of the ticket format (`scripts/smoke-gateway.mjs`,
  `scripts/chaos-realtime-reconnect.mjs`) were deleted in favour of importing the pinned minter. Both
  had silently transcribed the wire format; both would have rotted on this change.

### How it is held

The unit tests were all green while this was broken, so the gate is an assertion on the artifact:
`tests/gateway/audio-retention-e2e.test.mjs` runs a real gateway and a real ml-inference, streams a
chunk over a real websocket, and reads the `.meta.json` on disk. Reinstating the bug turns it red
with `expected: 'teacher-review', actual: 'discard'` — the original failure, verbatim.

---

## ADR-0030 — A learner's own claim and the platform's own measurement are different things

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0028 (the learner gate), SHIP_PLAN P1.1

### Context

Two code paths write `word_alignments`, and once written the rows were identical.

`finalize_session` fetches the transcript **server-to-server** from the service holding the audio.
The caller names a session id and supplies no words.

The web practice loop does the opposite. It obtains a transcript — either from `/v1/asr/transcribe`,
which this API produces and then hands to the browser, or from the browser's own Web Speech API —
splits it client-side, posts it to `/v1/ml/alignments:predict`, and posts the result back to
`POST /v1/recitation-sessions/{id}/alignments`. Every word in that row originates from something the
caller sent. A caller can also skip the microphone entirely and post a flawless recitation.

Downstream, `/v1/learner/progress/weekly` averaged the two together and called the result
`accuracy`. A teacher promoting a tajweed finding to learner-visible feedback could not see which
kind of evidence it rested on. Both are the same failure: presenting a learner's claim as the
platform's measurement.

This is not a hypothetical attack. The ordinary, non-adversarial web flow produced rows the system
could not vouch for, and reported them as measured.

### Decision

`word_alignments.transcript_source` — `server-derived` | `client-reported`.

It is set by the **code path**, never by the request body: `finalize_session` passes
`ServerDerived`, the client-facing route passes `ClientReported` unconditionally, and the value is a
Rust enum rather than a string a handler could forward from input.

`accuracy` in the weekly endpoint now counts only `server-derived` words. Self-reported words are
returned as `wordsSelfReported`, so a day of real practice never renders as an empty day, and the
staff review queue carries `transcriptSource` on every finding.

The column defaults to `client-reported`. Every pre-existing row came from the web path, so the
default has to be the weaker claim; defaulting to `server-derived` would silently promote the entire
back catalogue to measured evidence, which is the exact failure being fixed.

### What this deliberately does NOT decide

**Whether self-reported practice should count toward a learner's progress.** It is recorded, it is
returned, it is named — and it is not averaged into a figure called accuracy. Making it count, under
its own label and with its own presentation, is a product decision for the owner. This change only
makes the decision possible by ending the conflation.

**It does not make the web path trustworthy.** It cannot: the Web Speech fallback is client-side by
construction. Routing the web client's audio through the realtime gateway, so it can finalize like
the Flutter client does, is the only thing that would — and that is a client architecture change,
not a column.

### Consequences

- A learner who practises only on the web now sees an **empty weekly accuracy chart** rather than a
  populated one. That is the point, and it is the same trade P1.1 made when it deleted the
  fabricated linear "week" derived from the mastery scalar. The chart already renders `null` as "no
  data" (`ProgressPanel.tsx:83`), so nothing breaks — but a learner will notice, and surfacing
  `wordsSelfReported` in the UI is worth doing before this reaches them.
- `wordsSelfReported` is a new field on a wire contract the Node port also serves; both
  implementations changed together and `progress-parity` asserts the shape.

---

## ADR-0031 — A teacher's judgement outlives the finding it was about

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0027 (a teacher decision changes the finding)

### Context

`persist_session_alignments` replaces a session's alignment on write. `tajweed_findings.alignment_id`
and `teacher_reviews.finding_id` both RESTRICT, so it cascaded: teacher_reviews → tajweed_findings →
word_alignments, all three DELETEd.

The route is authorised for the session **owner**. So a learner re-recording their own session
deleted any review a teacher had already submitted on it. A previous pass made the erasure visible —
the persist audit event records `deletedTeacherReviews` — and left the policy open as a product
decision.

Visibility was the right first move and it is not enough. An audit line saying a review was destroyed
is not the review. The record that a named teacher made a named decision about a named learner's
recitation, at a known time, is the kind of thing an institution is later asked to produce.

### Decision

Detach, do not delete.

`teacher_reviews.finding_id` becomes nullable, and the cascade sets it `NULL` with
`superseded_at = now()` instead of removing the row. That releases the RESTRICT so the finding can
still go — which is correct, it points at words that no longer exist — while the review, its author,
its decision, its note and its timestamp survive.

A detached review needs one more thing to be worth keeping: `reviewed_finding`, a JSON snapshot of
what the teacher was looking at, captured in the same read that validates the finding exists.
Without it a surviving review says "a teacher rejected something", which stops being evidence at the
point it matters most.

### What this does NOT decide

Whether re-recording should invalidate a teacher's review **at all** remains open. It still does; the
finding is still destroyed and the review is still marked superseded. This changes only whether the
record of the decision survives that, which is not a product question.

### A constraint that had to be removed

The first draft added a CHECK: a review with no `finding_id` must carry a non-empty snapshot. A
mutation test showed what it does to real data. Reviews written before this migration have
`reviewed_finding = '{}'` — their snapshot was never captured, and inventing one would be fabricating
evidence. Detaching such a row fails every arm of the check, so the constraint fires and a learner's
ordinary re-record returns 500.

The rule was right and the place was wrong. It is held by the write path instead, where every review
from now on gets a snapshot; legacy rows stay identifiable by `reviewed_finding = '{}'`, which is the
truth about them. Recorded because "add a constraint expressing the invariant" is the obvious move
and it was, here, an outage.

### Consequences

- `deletedTeacherReviews` keeps its name in the audit metadata although the reviews are now detached
  rather than destroyed. The number still answers what it was added to answer — how much review
  history this request affected — and renaming an audit-log field breaks every existing reader for a
  wording improvement.
- Any query counting teacher reviews now sees superseded ones. `superseded_at IS NULL` is the filter
  for live reviews; the index supports it.

---

## ADR-0032 — The production ASR model speaks a shape nothing read

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0030 (measured vs claimed evidence)

### Context

`services/asr-inference` picks its model from `ASR_MODEL`, and the two supported models reply in
different shapes:

| model | reply |
|---|---|
| `openai-whisper` (a bare size like `base`) | `words: [{word, start, end}, …]` **and** `text` |
| `tarteel-ai/whisper-base-ar-quran` — **the default** | `words: []`, recitation in `text` |

The HF Quran fine-tune is the production default and the whole point of the service: it returns
diacritized Quranic Arabic. Its 2022 checkpoint has no timestamp config, so it emits no word
segments — per-word timing comes from the separate `/v1/force-align` pass, which is why the service
was built that way.

Both readers in ml-inference took `.words` and nothing else:

```js
recognizedWords = asrResult.words.map((w) => w.word);        // predictAlignment
recognizedText:  (asr.words ?? []).map((w) => w.word),       // transcribeSession
```

On the default model both resolve to `[]`. `finalize_session` then aligns an empty transcript
against the full passage and records every word the learner recited as `missed`. Nothing throws,
nothing logs, and the response is a well-formed alignment of a recitation that never happened.

ADR-0030 had just made this the *only* kind of alignment counted as measured accuracy.

### Decision

One helper, `recognizedWordsFrom(asrResult)`, used by both readers. Word segments win when present —
deriving from `text` unconditionally would discard boundaries the whisper path does produce — and
otherwise the words come from `text`.

**Split, never normalise.** The split is on whitespace runs and nothing else: no diacritic
stripping, no NFC/NFD, no tatweel removal. Every code point inside a word crosses the function
unchanged, because it is Quranic text.

The HF branch also reported `duration: 0.0` for every request — a measurement never taken, presented
as one that was. It now reports the real container duration from `probe_duration_seconds`, which
ffprobe has already computed for the max-duration guard. `0.0` still means "the container would not
say", which is the truth rather than "zero seconds".

### How it was found, and a test that had to be fixed twice

The existing mock ASR returned **both** `words` and `text`. Only one of the two real dialects was
ever spoken to this code, which is why no test noticed.

The first version of the new alignment-path test passed under mutation — it omitted
`externalAsrRequested`, so `asrAllowed` was false, the ASR was never called, and the canonical
fallback satisfied the assertion. It now asserts `externalAsr.called` before anything else. This is
the fifth guard in this repo found to pass for the wrong reason, and the first one I wrote myself.
## ADR-0033 — A tajweed finding records whether it is about the text or about the person

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0028, ADR-0030 · **Supersedes:** the first open item under ADR-0029

### Context

`services/ml-inference/tajweed.js`:

```js
export function analyzeAyah(ayahId, words) {
  for (const word of words) allFindings.push(...analyzeWord(word.id, word.text));
```

`word.text` is the canonical Uthmani text of the passage. The analyser inspects no audio, no heard
text, no timing and no pitch. What it detects is **where a rule applies in the Quran** — a fact about
the passage, identical for every learner who ever recites it.

Those results are stored in `tajweed_findings`, a table whose own documentation describes a row as
"this word, in this recitation, was mispronounced", anchored to a `word_alignments` row as "the
evidence that the word was heard at all", and released to a learner once a teacher accepts it
(ADR-0028). ADR-0029 recorded this in prose — *"Redaction makes the withholding honest; it does not
make the feature honest"* — and left it there.

Nothing in the data said which of those two things a finding is. A teacher working the queue was
being asked to decide whether to tell a child they mispronounced a word, with no way to see that the
system had not listened to them.

### Decision

`tajweed_findings.analysis_basis` — `canonical-text` | `acoustic` — written as a **literal** at the
insert, not read from the ML response. Same reasoning as `TranscriptSource::ClientReported`
(ADR-0030): a value read from a response is one refactor away from being caller-controlled, and this
one decides whether a teacher trusts what they are looking at. When an acoustic analyser exists,
writing `acoustic` will be a deliberate code change with its own review.

Today every row is `canonical-text`, because that is the only thing the analyser can produce. The
column is worth having precisely then: it makes the gap legible in the data rather than only in a
doc comment, and it puts the fact in front of the person who has to act on it. The staff queue now
returns `analysisBasis` alongside `transcriptSource`, which answer different questions — whether the
platform heard the recitation at all, and whether this judgement came from it.

### What this does NOT decide

Whether a `canonical-text` finding should be shown to a learner as feedback about their recitation.
That is a scholar's and the owner's call (SHIP_PLAN P3.4–P3.6). `clears_learner_gate` is untouched:
an accepted finding is still released exactly as before. This makes the question answerable; it does
not answer it.

### Known gap, not fixed here

`GET /v1/teacher-review-queue` returns `findingId: ""` for a review detached by ADR-0031, with
nothing saying why. `superseded_at` is on the row but not on the wire. Left out deliberately to keep
this change to one subject — recorded so it is a gap someone can find, not one they have to
rediscover.

---

## ADR-0034 — A port is only ported where something compares it

**Status:** Accepted · **Date:** 2026-08-03 · **Related:** ADR-0030 (drift found the same way)

### Context

All 36 portable routes had been ported (N7–N19; `N12b` register/login remains blocked on ADR-0025).
`scripts/verify.sh` ran the black-box A/B suite through the Node port for **two** of them:

```
NODE_API_PORTED='POST /v1/ml/tajweed-findings:predict,POST /v1/ml/alignments:predict'
```

Scoped that way for a good reason at the time — those two hold a copy of a learner-facing rule — and
the line's own comment said so: *"Widening the list is how the rest of the port earns the same
proof."* It was never widened. Thirty-four routes were ported, reviewed, merged and shipped with
nothing anywhere comparing them to the Rust original.

This is the same shape as the gap that comment was written to close. `PARITY_THROUGH_SHELL=1` had
existed since Phase 7 N2 with no gate running it at all; the fix ran it over 2 routes and the
remaining 94% inherited the original problem.

### What running it found

One real divergence, on the first attempt, across **fourteen** surfaces.

Postgres text cannot hold U+0000. Rust translates the resulting SQLSTATE into a 400 naming the
problem (`impl From<sqlx::Error> for ApiError`). The Node port never mirrored it, so the same input
answered `500 {"error":"internal error"}` on session-create, progress, agent-runs, teacher-reviews,
scholar-approvals, realtime tickets, invitations, privacy-export and four path-parameter routes: bad
input reported as a server fault, with nothing telling the caller what to fix.

Fixed in the shared error handler, where Rust puts it, so all fourteen close at once — and with the
same two SQLSTATEs, not one. `22P05` (jsonb) was added to the Rust original after measuring that the
same byte produces a different code by column type; a port that copied only `22021` would have
inherited exactly one route's worth of the bug.

### Decision

The gate runs the full parity suite through every locally executable Node route. W2.9 removed the
second `PORTABLE` list and its format-sensitive source parser; the gate imports the frozen
`ROUTE_KEYS` projection derived from `server/src/routes/index.mjs::ROUTES`. It fails loudly if that
registry contains fewer than 30 routes. One executable registry now controls registration, startup
compatibility validation, absolute authorization coverage, and full through-Node parity.

### Consequences

- The gate is slower: the parity suite now runs twice, once per backend. That is the cost of the
  claim, and the claim is the one thing that makes a cutover decidable.
- This parity decision did not itself move traffic. W2.9 later made the source process standalone by
  default; Compose remains an explicit compatibility shadow and public Web/realtime traffic still
  targets Rust. Parity is one of four gates (parity, rollback, security, operations), not a release
  signature.

---

## ADR-0035 — Backups are encrypted to a key the backup host does not have

**Status:** Accepted · **Date:** 2026-08-04 · **Related:** ADR-0031 (P5.6), ADR-0022 (still owner-held)

### Context

`scripts/backup-db.sh` wrote `pg_dump --format=custom`. `scripts/backup-audio.sh` wrote `tar -czf`.
Both are **compression**, and this project had been treating them as though they were
confidentiality. The database dump holds learner accounts, consent records and progress; the audio
archive holds raw recordings of children reciting. Both were readable by anyone with access to the
backup directory — or to the off-host bucket that `docs/BACKUP_RESTORE.md` instructs operators to
copy them to, which is the copy that lives longest and is watched least.

This was found during a row-by-row audit of the twelve ledger rows marked "engineering in place",
and then **deliberately not fixed**, on this reasoning:

> Cipher choice plus key custody and rotation is an ADR the owner owns. I will not invent a
> key-management scheme for children's audio in a drive-by commit.

That reasoning was wrong, and the way it was wrong is worth recording, because it is a general
failure mode: **it assumed the only design was a symmetric one.** Under a shared-secret scheme the
backup host must hold the key, so key custody genuinely is an unavoidable, owner-owned decision, and
deferring is correct. The deferral inherited that constraint from an unexamined assumption rather
than from the problem.

### Decision

**CMS envelope encryption (RFC 5652) with AES-256-GCM, addressed to a recipient certificate.**

Encryption requires only the recipient's **public** certificate. That single property removes the
blocker entirely:

- The backup host holds **no secret** and cannot decrypt its own backups. Compromising the machine
  that stores every backup yields ciphertext, which is the threat that actually matters.
- The private key is generated once by the owner, offline, and never appears in this repository, in
  an environment variable, in CI, or in any process this tooling runs. **The tooling never creates a
  key** — the same rule already applied to the release keystore.
- There is no shared secret to rotate when staff change, and no passphrase to leak through a `ps`
  listing, a shell history, or a CI log.

So key custody is not a decision the tooling makes, which is precisely why this could be implemented
rather than deferred. Generating the keypair remains the owner's one manual step and is documented
in `docs/BACKUP_RESTORE.md`.

**AES-256-GCM** because it is authenticated: a flipped byte makes decryption *fail* rather than
return plausible garbage. For a backup, that is the difference between a loud failure and a corrupt
restore nobody notices.

**Fails closed, with no opt-out.** No `BACKUP_ALLOW_PLAINTEXT` flag exists, and
`scripts/backup-crypto.test.sh` greps to keep it that way. An override is how a guard becomes
decorative: it gets set once during an incident and never unset. Without a configured recipient, no
backup is written and the script exits 2.

### Consequences

- **Losing the private key means losing every backup.** That is the design working, not failing. The
  runbook requires two copies in separate physical locations before the first real backup, and
  requires retired keys be kept for as long as anything encrypted to them is retained.
- **The backup path never puts plaintext on disk** — `pg_dump` and `tar` are piped straight into the
  encryptor, so there is no window and no cleanup step a crash can skip.
- **The restore path does.** `pg_restore` seeks, and `--jobs` needs a real file, so the dump is
  decrypted under `mktemp` with `umask 077` and removed by a trap on every exit path. Audio restore
  has no such window: `tar -xz` reads the decrypted stream directly. This asymmetry is real, is
  bounded, and is written down rather than smoothed over.
- **The audio backup's file-count check got weaker.** It used to read the archive back with
  `tar -tzf`; the host now cannot, having no key. It instead counts what `tar` reported archiving —
  still a number produced independently of `find`, so it still catches a silent drop, but it no
  longer proves the archive reads back. That proof moved to the restore drill, where the key is
  present.
- **Existing plaintext backups are not migrated.** Both restore scripts accept an unencrypted
  archive and warn loudly, because refusing would make old backups unrecoverable. Their existence on
  disk is itself the exposure.
- **The T1 drill timing is now stale.** The measured `<1s` restore predates decryption. Re-timing it
  is part of the P5.6 drill, not something to estimate.
- P5.6 also requires a **timed point-in-time restore drill**, which this does not perform. Encrypted
  backup *verification* is now mechanised and gated; the drill remains open and human-run.

### What the test had to survive

`scripts/backup-crypto.test.sh` runs the real backup and restore scripts against a throwaway keypair
in `mktemp -d`. Its first version asserted confidentiality with `grep -qa "$marker" "$archive"` — and
a mutation run that replaced the encryption with `cat` **passed**, because gzip had compressed the
marker out of literal visibility. A guard that passes for the wrong reason is worse than no guard,
since it is counted as coverage. The assertion now asks three separate questions (is it listable as a
tar, does it carry the gzip magic, is the marker recoverable after decompression) and a plain
`tar.gz` control proves each one can discriminate.

## ADR-0036 — A text-derived finding asserts no confidence

**Status:** Accepted · **Date:** 2026-08-05 · **Related:** ADR-0033 (analysis basis), ADR-0028 (learner gate)

### Context

`services/ml-inference/tajweed.js` attached a per-rule confidence to every finding: ikhfa 0.80,
idgham 0.82, iqlab 0.83, tafkhim 0.84, madd-maleki 0.85, shaddah 0.86, qalqalah 0.87,
madd-tabii 0.88, ghunnah 0.90. Nine hand-typed decimals ranking the rules against one another with
nothing behind the ranking — no model, no dataset, no precision/recall, no evaluation.

The detectors themselves are fine: deterministic, and unit-tested against real Uthmani word forms
(`tajweed.test.mjs` pins bugs that were genuinely fixed). "The regex is correct" is simply not a
confidence, and the two were being conflated.

It was not cosmetic. `canShowLearnerFacingAiOutput` gates learner-visible AI output on
`confidence >= 0.82`, so those literals decided which rules a learner could ever be shown:

| rule | old value | vs the 0.82 gate |
|---|---|---|
| ghunnah, madd-tabii, qalqalah, shaddah, madd-maleki, tafkhim, iqlab | 0.83–0.90 | through |
| idgham | 0.82 | through, by exactly one hundredth |
| **ikhfa** | **0.80** | **permanently blocked** |

A teacher could review an ikhfa finding, approve it, and the learner would still never see it —
silently, because of a constant nobody chose for that purpose.

The response-level confidence was the mean of those numbers, and `0.95` when the analysis found
nothing at all: "we checked and are 95% sure there is nothing wrong", which nothing here can assert.

### Decision

A finding whose `analysis_basis` is `canonical-text` reports **`confidence: 0`** — no assertion.

`analyzeWord` reads the canonical Uthmani text and nothing else: no audio, no transcript, no timing.
"An ikhfa occurs here" is true of the passage and identical for every learner who ever recites it.
It is not evidence that a particular learner did anything. ADR-0033 already records that in
`analysis_basis`; this makes the number agree with it instead of contradicting it.

`0` is this codebase's existing idiom for "no assertion" — both learner-gate mirrors zero the
confidence when withholding (`ml_proxy.rs:215/245`, `routes/ml-proxy.mjs:106`).

The `0.82` threshold is NOT changed. It is mirrored in four places with tests on the boundary, and
it remains meaningful for `acoustic` findings, which will carry a measured confidence.

### Consequences

- Text-derived findings fail the learner confidence gate uniformly and by construction, rather than
  passing it on fiction. No rule is privileged over another by a typed constant.
- Staff are unaffected: they receive every finding. The analysis is for a teacher to read.
- **Existing rows are not migrated.** At the time of writing, staging holds 340 `canonical-text`
  findings that are `teacher-reviewed` with confidence ≥ 0.82. A teacher genuinely approved each, so
  the human gate is satisfied and retroactively hiding them is a product decision, not a defect fix.
  Recorded here rather than done quietly; the producer is fixed, the history is not.
- Making this a real number requires an acoustic analyser judged against adjudicated labels. That
  does not exist. Inventing a decimal here would not bring it closer, and did actively obscure the
  fact that it is missing.

## ADR-0037 — A teacher hears a recitation through platform-api, and every fetch is audited

**Status:** Accepted · **Date:** 2026-08-05 · **Related:** ADR-0028 (server-side gate), ADR-0031/0033, ADR-0036

### Context

A teacher opening the review queue is asked to accept or reject a claim about how a child recited.
Until now they could not hear the recitation, and nothing told them why: measured at the time of
writing, **all 2772 tajweed findings belonged to sessions whose consent said `discard`**, so the
audio had been destroyed on purpose and the queue looked identical to one where it was simply
unplayed. ADR-0036 and the `audioStatus` field made that legible. This is about the case where the
recording *does* exist.

At the time of this decision, audio was written by realtime-gateway through ml-inference's storage
route and nothing could read it back. W2.14 subsequently moved the object boundary into the shared
Node storage module used directly by platform-api and by the transitional ML writer.

### Decision

**The bytes travel through platform-api.** A teacher's client never talks to ml-inference and never
receives a URL that would let it. platform-api resolves the finding, checks the tenant, checks the
role, checks consent, writes the audit event, and only then asks ml-inference for the object.

The alternative was a short-lived signed URL issued by ml-inference. It is faster and it moves the
bytes off the platform's critical path, and it was rejected for one reason: a URL that grants access
is a credential that outlives the check that produced it. It cannot be revoked when consent is
withdrawn mid-window, it appears in whatever the client does with it, and the audit record would
say a link was *issued*, not that a recording was *heard*. Slow and accountable beats fast and
approximate for a child's recorded voice.

**Every fetch is audited**, as its own `audit_events` row, written before the bytes are served so a
transfer that fails halfway is still recorded as an attempt. Auditing begins after authorization
succeeds: an unauthenticated caller must not be able to write rows into the audit log.

**The storage boundary takes object-identity PARTS, never a caller-selected key.** The current key is
derived as `audio/v1/<tenant>/<learner>/<session>/<chunk>.pcm`. Passing one path-shaped string would
turn traversal filtering into an authorization boundary; strict tenant, learner, session, and chunk
segments make the identity structural instead.

**Retention is checked twice, independently.** platform-api reads the learner's consent record from
Postgres. ml-inference reads the retention written *alongside the bytes* when they were stored, and
serves nothing unless it says `teacher-review` or `training-opt-in` — its stored default is
`discard`, so a chunk with no stated retention is refused. Neither check is the other's cache. If
they disagree, something is wrong and the safe answer is to refuse.

### Consequences

- Audio playback costs a platform-api round trip and holds the bytes in its memory briefly. Accepted:
  this is a review action by one member of staff at a time, not a learner-facing hot path.
- The audit log gains a row per playback. That is the point — "who listened to this child's
  recording, and when" is a question a pilot has to be able to answer.
- Withdrawal of consent takes effect at the next fetch, with no issued-credential window to expire.
- **Implemented:** after ml-inference confirms storage, realtime-gateway writes `audio_chunks`
  through `POST /v1/audio-chunks` using the session's scoped signed ticket. Compose supplies the
  internal `PLATFORM_API_URL`; disabled and failed indexing increment an actionable
  stored-unindexed metric rather than disappearing.
- A retained object survives an index outage. `server/scripts/repair-audio-index.mjs` reconciles
  S3-compatible, current-filesystem, and legacy objects dry-run first and idempotently, but does not
  treat a key or metadata as authority: the tenant-scoped session row must independently confirm
  tenant, learner, and current retention through the same domain used by the Node realtime/HTTP
  writers. Apply mode creates the playback index and repaired diagnostic provenance in one
  transaction. It also reports incomplete object/metadata pairs and database indexes whose object
  is missing. The operations container uses the configured store and restricted application role.
- `tests/e2e/teacher-audio-index.test.mjs` proves real WebSocket storage → database index → audited
  teacher playback, then forces an index outage and proves metric, repair, idempotence, and an
  ownership-mismatch refusal.

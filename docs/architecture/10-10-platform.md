# Quran AI 10/10 Platform Architecture

## Current Implemented Slice

- `apps/web`: React/Vite platform command app — learner practice flow (record → real ASR
  transcription → alignment/tajweed feedback) and the internal ops console (agent runs, scholar
  queue, live recitation streaming, benchmark/eval view).
- `apps/mobile`: Expo/React Native learner app (login, surah picker, consent-gated recording,
  ASR + alignment feedback via the platform API). Not a pnpm workspace member; its pure-logic
  helpers (`lib/session.ts`) have their own `node --test` suite, gated in
  `.github/workflows/mobile.yml`.
- `packages/contracts`: permanent API/contract boundary. It owns the OpenAPI 3.1 document, the
  mechanically checked 42-operation baseline/target route manifest, shared TypeScript contracts
  for platform and canonical Quran records, proof gates, checksum verification, retention
  decisions, and the learner-facing AI gate (`canShowLearnerFacingAiOutput`). The four inference
  proxy responses are bound to strict producer-owned schemas; no operation is `x-unvalidated`.
  The model-evaluation boundary has one strict signed-bundle schema and an operator-owned Ed25519
  public-key policy. `scripts/model-evidence-verifier.mjs` canonicalizes the evidence object with
  RFC 8785, checks its exact SHA-256 and detached signature, and keeps signer trust outside the
  bundle. The committed production policy starts empty; fixtures and ephemeral test keys cannot
  become release authority.
  Inference responses use a closed component-attribution contract: each active ASR, forced-aligner,
  Quran-aligner, acoustic-scorer, or calibrator record identifies its implementation, exact
  artifact digest, dataset, and analysis basis. The compatibility `modelVersion` is derived from
  the primary component and is not accepted as client authority.
- `packages/quran-data`: canonical Al-Fatihah seed (checksum-verified via `@quran-ai/contracts`),
  source manifests, and a server-only full 114-surah bundle acquired from Al Quran Cloud edition
  `quran-uthmani` (`fetch-full-quran.mjs` + `scripts/seed-full-quran-to-db.sh`) seeded into
  `canonical_ayahs`/`canonical_words`. Its reviewed, append-only provenance v2 record pins the
  direct provider, edition, terms, counts, legacy checksum, and independently length-delimited
  ayah/word-token SHA-256 values; the exact upstream artifact remains unresolved. The production
  seed validates this record before emitting SQL.
- `services/platform-api`: Rust/Axum + SQLx/Postgres tenant-scoped API — auth (register/login,
  bcrypt, JWT), recitation sessions, learner progress (real SM-2 spaced repetition), privacy
  export/delete (storage-first audio erasure), teacher reviews, scholar approvals, agent-run
  recording, eval-run lookup, audit events, and realtime ticket issuance. Tenant isolation is
  enforced by Postgres RLS on every tenant-owned table. Migration 0018 adds a structured optional
  `agent_runs.learner_id`; the agent-run API can persist it and privacy export/deletion use it for
  learner-linked runs. Cohort-level or legacy runs without that structured key are not attributed
  by free-text inference. Finalized server-derived words share one `alignment_runs` record that
  stores the exact component attribution, dataset, evidence, consent snapshot, latency, source, and
  audit reference. A composite run/tenant/session foreign key prevents stale or cross-tenant
  provenance attachment; staff read it through the existing tenant-scoped alignment endpoint.
  See `docs/DATA_INVENTORY.md` §1.
- `services/realtime-gateway`: Rust/Tokio/Axum realtime gateway — ticket-authenticated (HMAC,
  single-use, tenant-bound) WebSocket audio ingress, origin-checked (CSWSH-resistant), bounded
  per-session channel with backpressure, forwards chunks to the private `job-worker` compatibility
  ingress, then records the stored object through platform-api before teacher playback can discover
  it. Metrics distinguish forward loss, attempted index failure, disabled indexing, and the
  aggregate stored-unindexed count. The gateway remains the realtime compatibility oracle until W3
  canary and rollback gates permit a Node realtime cutover.
- `services/asr-inference`: Python/FastAPI — real acoustic ASR via `openai-whisper`
  (`ASR_MODEL` configurable; the current deployment runs generic Whisper `base`, not the
  Quran-tuned `tarteel-ai/whisper-base-ar-quran` default in code — see the `ASR_MODEL` comment in
  `docker-compose.yml` for why). The image also carries one candidate registry: runtime configuration
  must match its model, revision, and artifact digest before allocation. Hugging Face candidates
  require a full commit and a byte-verified weight file; aliases fail. The registry intentionally
  records `blocked-no-eligible-benchmark`, so generic `base` is an operational placeholder rather
  than an accuracy winner. API-key gated, rate-limited. ASR, forced alignment, and acoustic
  scoring author separate digest-bound component records; an undeclared external checkpoint or
  unavailable calibrator cannot be presented as active. Process-only `/health` binds before model
  loading; `/ready` and ASR route admission share one cached state that requires the configured
  artifact digest and a bounded deterministic inference probe. One background worker retries
  transient failure without overlapping model/probe work; Compose depends on `/ready`.
  An optional, non-Compose `acoustic-candidate` image target pins Muaalem v3.2, its implementation,
  QPS implementation/profile, and every model file. It exposes only a private 16 kHz/15-second
  reference-aware shadow observation route through a restartable child. The normal image omits the
  2.4 GB artifact. Phoneme softmax values are uncalibrated; sifat scores are withheld because the
  pinned upstream mismatch decoder can substitute class ids for probabilities. The separate
  calibrator loader requires exact calibrator bytes plus scorer-artifact, dataset-manifest, and
  evaluation-evidence digest bindings. Its committed registry has no active entry, and the
  shadow-only candidate refuses activation. Neither raw score can enter `findings[]`. The
  superseded standalone experiment has been removed from the repository.
- `services/agents`: Node — supervised agent workflows (Tajweed Explainer, Mistake Pattern
  Summarizer, Practice Plan Recommender), each producing a sourced, reviewer-gated `agent_run`.
  No agent output reaches a learner without clearing `canShowLearnerFacingAiOutput`.
- `services/shared-ticket`: Rust — HMAC realtime-ticket issuance/validation shared by
  `platform-api` (issuer) and `realtime-gateway` (validator), so the signing logic lives in one
  place.
- `server` / Compose `node-api` + `job-worker` + `node-realtime`: the single production Node package
  and image. The image is built from the frozen server workspace production graph on digest-pinned
  Node 22.13.1, runs as
  the non-root `node` user, publishes no host port, and uses native bounded healthchecks. `node-api`
  owns request admission and synchronous compatibility responses; `job-worker` owns durable job
  execution, retained-audio writes/retention, and the server-local inference runtime;
  `node-realtime` is an internal, independently drainable process with liveness, bounded deep
  readiness, private fixed-cardinality metrics, W3.3 ticket/Origin/rate admission, W3.4 durable
  replay, and the W3.5 bounded audio runtime on the exact session-audio route. The process receives
  no traffic and Rust remains the only realtime traffic target.
  The worker's key-gated,
  rate-limited private listener on port 8098 exists only for the measured Rust/gateway compatibility
  consumers and exposes a closed route allowlist.

  The inference runtime performs Quran-constrained word alignment over a comparison-only Arabic
  projection, deterministic instructional Tajweed analysis, consent-gated ASR proxying, bounded
  multi-window transcript assembly, exact producer attribution, and optional acoustic shadow
  observation. Instructional rules return only as `analysisBasis=text-rule`; learner-performance
  `findings[]` remain withheld without calibrated, evaluated, approved acoustic evidence. Online
  inference cannot create evaluation evidence; only the offline row-authoritative evaluator and
  detached-signature verifier can do so.

  With no upstream the package starts standalone from one 44-operation declared registry: 41
  operations are enabled by default (all 38 retained baseline operations, learner history, and two
  removal-blocked agent transition operations), while the three implemented device-identity
  operations remain unregistered unless `DEVICE_IDENTITY_ENABLED=1`. Unknown paths are local 404s
  and unavailable pilot-cookie DB resolution fails closed; no handler can fall through to Rust.
  Base Compose deliberately supplies the retained Rust upstream, selects `explicit-compatibility`
  mode with only `/health` and `/ready`, and keeps Web plus realtime indexing pointed at Rust. The
  explicit `docker-compose.canary.yml` overlay instead derives exactly 39 Node-owned routes from the
  contract manifest and switches Web plus gateway indexing to Node while Rust stays healthy for
  transition routes and reversal. There is no random split or dual-write path. The
  runtime image contains only declared production libraries, package-owned Node/inference modules,
  and their exact attribution/provenance inputs—no TypeScript, tests, Web, contracts package, Rust
  service, legacy Node tree, or broad Quran source tree. The former standalone ML source tree,
  service, and image have been removed.
- `infra/migrations`: immutable, manifest-checksummed Postgres schema history, including tenant RLS,
  learner-progress isolation, superuser-only bypass protection, uniqueness guarantees, and the
  structured agent-run learner key used by privacy export/delete. `server/scripts/migrate.mjs` is
  the only migration boundary: advisory-locked, transaction-per-file, and database-ledger checked.
  Full Quran seed generation is owned by `packages/quran-data`; restricted runtime-role rotation is
  a separate provisioner under `infra/provision`.
  Migration 0030 retains historical deterministic Tajweed rows for audit as `text-rule` with null
  confidence, while database constraints and review/read queries reserve learner-performance state
  for non-null-confidence `acoustic` rows.
  Migration 0031 extends the existing RLS-protected `eval_runs` authority in place: historical
  aggregates are explicitly fixture-only/non-release, while computed evidence is all-or-nothing,
  digest-bound, signed, and immutable. Nullable historical finding provenance becomes an exact
  same-tenant composite reference whenever supplied; no second evaluation table is introduced.
  The staff EvalRun read model exposes this complete authority state in one strict shape. Rust and
  Node preserve identical field order and JSONB ordering; React consumes the shared TypeScript type
  and cannot paint fixture/research rows as passing release benchmarks.
  Migration 0032 demotes the remaining historical `eval-passed` aggregate claim because the
  production signer policy is empty. The release checker considers every tenant-visible row,
  verifies exact signed bytes, and requires one unique release identity; creation order cannot hide
  evidence, while a conflicting or invalid release-labelled row fails closed.
  Migration 0033 makes every new acoustic finding reference one exact same-tenant acoustic
  evaluation chain. Stored finding reads join the alignment span, retained audio evidence, model,
  dataset, calibrator, evaluation and audit identities. One shared cross-runtime corpus requires
  every field plus human review and calibrated confidence. Historical, stale, fixture-bound,
  unverified, discarded-audio and uncalibrated rows remain reviewable but learner-withheld.
- `server/scripts/repair-audio-index.mjs`: dry-run-by-default reconciliation for S3-compatible and
  legacy/filesystem audio. Storage metadata only nominates a candidate; a tenant-scoped session row
  must independently confirm tenant and learner ownership before an idempotent index insert.
  Incomplete object/metadata pairs and index-without-object states are reported rather than guessed.
- `scripts/verify.sh`: canonical local/CI gate — Rust fmt/clippy, TS typecheck, TS/Rust/Node
  tests, live Postgres integration tests when reachable, production build, and web bundle secret
  scan.
- `scripts/smoke-*.mjs`: running-stack proof for SQL/RLS, API, gateway, ML, privacy, browser, and
  trace-linked aggregate smoke.

## Architecture Direction

The approved consolidation target keeps this repository and migrates it in place to one Flutter
client plus one modular Node codebase with separate API, realtime, and worker processes. The current
Rust/React/Expo services remain compatibility oracles until their canary and rollback gates pass;
they are not deleted by directory cleanup. `packages/contracts/route-manifest.json` records the
boundary: 42 current operations, four explicit retirements, 38 retained baseline operations, and
four separately named device-session/learner-history additions. Counts are derived from those sets.

### Target Node backend boundary (ADR-0050)

`server/package.json` becomes the single Node production dependency boundary with separate API,
realtime, and worker entrypoints. CPU-heavy inference stays off the API event loop. Production
retained audio moves to private S3-compatible storage with server-derived keys; filesystem storage
is a test/development adapter only. One monotonic request deadline propagates through Postgres,
storage, ASR, compatibility, and worker calls with `AbortSignal`, while bounded process admission
and durable Postgres credential/replay state avoid a new Redis or NATS dependency. Production
identity remains controlled device enrollment with server-derived tenant/role, rotating revocable
credentials, and provisioned staff. Deadline propagation, HTTP admission, the private object
storage data plane, durable domain work, device identity, and inference/worker consolidation are
implemented below. The explicit HTTP canary topology is also implemented, but production traffic,
infrastructure provisioning, native secure storage, and attestation remain target constraints rather
than current-state claims.

### Target realtime boundary (ADR-0051)

The same `server` package exposes a separate realtime process so its lifecycle can fail, drain, and
scale independently of API and worker event loops. It exposes `/health`, `/ready`, private
`/metrics`, and the exact admitted route with W3.4 replay and W3.5 bounded audio. It is an
internal no-traffic shadow. The Rust
gateway remains the compatibility oracle during W3. Rust-generated language-neutral `rt_v2` and
`audio.ack` fixtures are the shared wire authority; Node does not generate protocol truth. Browser
upgrades retain the exact Origin allowlist, while native no-Origin admission is an explicit policy
that never bypasses tenant/session/expiry/retention checks. Replay stores only a SHA-256 nonce hash,
never a raw ticket. A shared authority must fail closed; the W3.4 cross-instance benchmark
selected restricted Postgres for Node. Each session uses a bounded queue and explicit ack semantics;
ack message text is diagnostic only. W3.1 records this boundary and its fixtures; W3.2 implements
the independently drainable process lifecycle. Replay and bounded audio are implemented below;
durable outcome/index repair, recovery, image parity, and traffic switch remain separately gated.

### W3.3 realtime admission (ADR-0052)

The Node shadow uses exactly pinned `@fastify/websocket` behind Fastify's existing lifecycle. The
plugin is registered before routes; only the exact session-audio route can upgrade after signature,
session, tenant, retention, expiry, maximum-lifetime, Origin/native, and bounded peer-rate checks.
A valid shadow upgrade completes `101`, hands only frozen claims without nonce plus nullable trace
to the socket seam, then—at the W3.3 milestone—closed 1013 without reading, storing, forwarding, or
acknowledging audio. W3.5 replaces only that production default; the explicit admission-only test
seam preserves the historical proof.
Admission metrics have six fixed outcomes and no identity labels. There is no host port, proxy
target, client change, or data-plane traffic; Rust remains the only realtime traffic target. W3.5
owns bounded audio.

### W3.4 durable replay (ADR-0053)

Before upgrade, the Node realtime role atomically claims the exact signed nonce's lowercase UTF-8
SHA-256 under tenant/session forced RLS. Postgres database time rechecks expiry and the visible
session/learner; an existing/absent claim is generic 401 and database failure is bodyless 503 with
no in-memory fallback. Migration 0036 stores no raw ticket/nonce, preserves the u64 expiry domain,
cascades with session privacy deletion, and supports bounded ordered `SKIP LOCKED` cleanup. The
restricted two-pool 512-claim/concurrency-32 profile passed the approved p95 and throughput bars,
selecting Postgres for Node while leaving the Rust Redis oracle and all traffic routing unchanged.

### W3.5 bounded audio runtime (ADR-0051/0052)

After admission and the durable replay claim, the Node shadow accepts binary application messages
up to 2 MiB behind a 2 MiB + 64 KiB transport ceiling. It retains at most 8 chunks and 4 MiB per
session, 64 MiB process-wide, and 100 active/draining sessions; outbound acknowledgement buffering
is capped at 64 KiB. Empty/oversized/backpressured messages do not consume sequence, text is ignored
for Rust parity, and same-process reconnect cursors are limited to 1,024 entries for six hours.
`accepted=true` means enqueued, not stored. One FIFO consumer per session attempts the existing
create-only object-store boundary with a two-second abort signal; store and ingress outcomes remain
separate fixed-cardinality metrics. Shutdown drains for a derived maximum of four seconds, aborts
uncooperative work, clears accounting, then closes replay/storage/database resources.

This is still a no-traffic shadow. Durable stored/unindexed/lost/repair state belongs to W3.6,
reconnect recovery belongs to W3.7/W4.11, and the raw wire cannot describe the browser WebM/MP4
codec or negotiated 24/48 kHz rates. That browser WebM/MP4 mismatch remains a cutover blocker;
Rust stays the public traffic target.

The implemented W2.16 device-identity boundary is additive migration 0035 plus three Node routes,
one identity-domain module, and one audited operator command. Invitations and access/refresh
credentials are independent 256-bit opaque values whose raw bytes never enter Postgres; only
SHA-256 hashes are stored under forced tenant RLS. Invitation exchange derives tenant, user, and
current role from stored state. Access lasts 15 minutes; activity may extend the seven-day idle
window without exceeding the original 30-day absolute family lifetime. Refresh rotates both
credentials into the next generation, while reuse of a rotated refresh credential revokes the
entire family before a generic 401. Logout revokes the same family. Provisioning is restricted to
a stored in-tenant admin through `server/scripts/provision-device-enrollment.mjs`; the command can
optionally create only learner/teacher/scholar users and emits the raw 24-hour invitation once.
Privacy export contains count-only markers and privacy deletion removes both device tables inside
the fenced tenant transaction. `DEVICE_IDENTITY_ENABLED=1` is required to register the routes and
Compose passes it with a default of zero, so owner approval—not a deployed migration—controls
activation. W4.10 still owns Keychain/Keystore, auth-state rebuild, and native key binding.

The implemented W2.10 HTTP boundary is dependency-free and ordered: literal/exact non-credentialed
CORS, maintenance, default-on per-process admission, parsing/body ceilings, route authorization,
fixed error redaction, and bounded-label response metrics. Admission uses a 200-request burst, one
token per 50 ms, and a 10,000-client idle/LRU state cap. Socket peer identity is authoritative by
default; forwarded identity is considered only after an explicit bounded trusted-hop opt-in. This
does not by itself satisfy drain, job, durable-enrollment, or realtime-admission tasks.

The implemented W2.11 database boundary keeps one package-owned `postgres` pool. Fastify refuses to
become ready when that pool's effective role has superuser, RLS-bypass, database/role-creation, or
replication capability; the pool closes with the application lifecycle. Tenant-owned queries enter
through `withTenant`, or through `withDiscoveredTenant` only when a locked-down security-definer
function must discover tenant identity first. Both install the same transaction-local tenant GUC
and bounded statement timeout. Raw runtime SQL is statically limited to immutable canonical-Quran
reads, readiness `SELECT 1`, and the two pre-tenant pilot security-definer lookups. Database drivers
have one runtime owner; migration/provision/repair scripts remain the three explicit operator
owners.

The implemented W2.12 dependency boundary creates one request-scoped monotonic deadline before
local API work. A dependency-free helper composes elapsed-time and caller-disconnect signals and is
used by compatibility forwarding, ML/ASR calls, privacy erase, review audio, finalization, ML→ASR
windows, and the agents worker. Postgres startup parameters bound every connection server-side;
tenant transactions reduce `statement_timeout` to the remaining request budget, and timeout aborts
roll the transaction back before a retryable response is sent. Review playback is durably audited
as attempted before storage, and marked served only after the complete object validates.

The implemented W2.13 process boundary installs signal handling before the API listens. One strict
grace clock starts Fastify close, refuses late requests, preserves active HTTP responses, closes
new/idle sockets, and reserves its final fifth for Postgres.js teardown. At that boundary the
controller closes remaining HTTP and raw/upgraded sockets; a repeated signal escalates the same
controller and a hard deadline exits non-zero. Fastify is explicitly configured not to force active
connections at close because pinned 5.11's native branch otherwise calls `closeAllConnections` for
its documented idle setting. Node 22 owns idle reaping, while the controller owns forced closure.
The image sends SIGTERM and Compose's default ten-second stop window exceeds the app's eight-second
budget. The API exposes no WebSocket route. The W3.5 realtime process admits only its exact
authenticated shadow route and runs the bounded audio handler; every other upgrade remains unavailable.
The shared shutdown controller prevents an admitted or unexpected socket from hanging deployment.

The implemented W2.14 storage boundary uses one async interface injected into the Node API and
worker-owned inference runtime. Production requires an explicit private S3-compatible bucket;
create-only conditional puts, full SHA-256 validation, server-side encryption settings, paginated
listing/deletion, per-key delete
error inspection, readiness, and cancellation are enforced. Keys are derived only as
`audio/v1/<tenant>/<learner>/<session>/<chunk>.pcm` from verified server identity. Filesystem is an
explicit test/development adapter and can read legacy objects during migration. Node review and
privacy routes access the injected store directly; measured Rust/gateway consumers use only the
worker's private compatibility seam. Storage/index completion is honestly non-atomic: identical
retries are idempotent, changed immutable metadata conflicts, and the dry-run-first reconciler
reports or repairs the supported orphan states under tenant/session ownership checks.

The implemented W2.15 job boundary uses one additive, checksum-locked `background_jobs` table as
both queue and transactional outbox. Its four closed kinds are session finalization, session
Tajweed evaluation, privacy export, and privacy delete. Forced tenant RLS, deterministic
`SKIP LOCKED` claims, bounded attempts/backoff, lease generations, and fenced completion prevent a
stale process from committing a database effect. Remote inference and object erase may repeat;
domain writes and completion share one transaction. A privacy intent captures the bounded manifest
before erase, so recovery can idempotently repeat storage deletion and commit the original receipt.
Payload/result validation excludes audio, transcripts, credentials, dependency addresses, and
unbounded caller documents.

The same `server` image runs a private `job-worker` command: it discovers the global institution
registry, rotates the tenant poll start, and performs every queue read/effect under the restricted
role's ordinary tenant transaction. The API enqueues and waits within its request deadline; it does
not execute durable work inline. The worker is the only execution owner, including first attempts,
retries, and crash recovery. Worker metrics expose only closed state/kind/outcome labels, and
shutdown drains the runtime plus storage/database resources. Dead
letters remain immutable. An internal restricted-role command permits only in-tenant admin/ops to
create one audited successor, preserving replay lineage instead of resetting a fence. No online
evaluation writer or signing authority exists in this boundary.

The implemented W2.17 cutover moved alignment, Tajweed, transcript, acoustic-shadow, retained-audio,
and privacy inference handlers into `server/src/inference`. `node-api`, `job-worker`, and
`node-realtime` are three commands of the exact same OCI image; Compose, release inventories, smoke
tests, and Docker CI pin
that single image identity. The worker injects the exact same object-store instance into inference
and durable workflow execution, so write/read/retention/privacy behavior cannot drift between
process-local adapters. A private key gate, closed route allowlist, rate admission, body limits, and
monotonic deadlines contain the temporary Rust/gateway compatibility listener. ASR intentionally
remains a separate Python model process. Public HTTP and realtime compatibility cutovers remain
independent canary decisions; source deletion did not silently move traffic.

The implemented W2.18 HTTP canary topology keeps base Compose Rust-safe and makes traffic movement
an explicit overlay choice. `docker-compose.canary.yml` starts Node in `retained-canary` mode,
derives its exact 39-route allowlist from `packages/contracts/route-manifest.json`, and points Web
and gateway indexing at Node together. Rust remains healthy and is the only executor for the four
retirement-transition operations during this window. Mutable retained requests are handled once by
Node; they are never duplicated to Rust for comparison. Removing the canary overlay restores the
base Rust targets. Immutable candidate/previous images are selected separately through
`docker-compose.release.yml`. The actual-image proof runner consumes that preserved selection,
inspects all eight running container image IDs plus the live Web/gateway/Node environment, uses
short-lived JWT actors, and labels responses only in canary mode so every retained request can prove
Node ownership. It exercises hostile/effect/privacy/tenant/audio behavior, deliberately removes the
Rust oracle, requires all 39 retained operations to remain local and all four transition operations
to fail at the compatibility boundary, then restores Rust in a failure-safe path. Its write-once,
24-hour evidence is proof input, never promotion authority. Prometheus now separates Node API,
worker, Node realtime shadow, Rust, and gateway signals without identity labels; the k6 runner has
closed classroom, burst, and soak profiles bound to candidate image and topology identities. The
one-shot stop controller
consumes the closed metrics/trust observation, never auto-promotes, and on any stop signal first
returns Web plus gateway indexing to Rust, then restores exactly the seven previous application
services without rerunning an old database image. It requires all seven containers healthy and proves
one request produced one stored effect before privacy-cleaning the synthetic learner. Controller
evidence distinguishes ordinary observation, deliberate drill, and incident runs. The release-mode
closure validator binds a protected signed monitoring observation and exact signed remote-CI checks
to the same candidate/image/topology/load/controller chain, then requires distinct active Ed25519
release-owner, security, and SRE approvals. Its only successful state is
`ready-for-manual-promotion`; it has no traffic mutation capability. Actual candidate/load
execution, rollback timing, remote CI, and human approval remain external T5 evidence until supplied.

Public password register/login and both generic agent-run operations are retirement targets
(ADR-0038). They remain served only during the strangler period and cannot be removed while a
production caller remains. Login stays owner-gated off. The implemented native server identity
path remains dormant by default until explicit production approval and the W4.10 secure native
client are both proven.

The winning architecture is a real vertical slice first:

1. Learner app captures mic audio and chunks it locally.
2. Realtime gateway applies bounded backpressure, stores consent-covered chunks, and writes their
   durable tenant-bound index; stored-unindexed outcomes are alerted and repairable.
3. Session transcription composes bounded ASR windows into measured absolute recognized-token spans;
   incomplete audio refuses finalization rather than turning storage loss into learner mistakes.
4. Quran-constrained mapping carries those source spans to heard canonical matches/misreads; omitted
   words and extra tokens receive no persisted canonical evidence, and partial output rolls back.
5. Teacher playback resolves the index, rechecks consent and role, audits the attempt, then fetches
   bytes from storage without exposing an object credential.
6. Canonical Quran text constrains word alignment and Tajweed instruction; retained audio plus
   server-derived spans may feed private acoustic shadow evaluation.
7. Low-confidence findings go to teachers before becoming learner-facing claims.
8. Religious explanations require source references and human review status.
9. Reviewed corrections become labeled eval/training data.
10. Model releases are blocked unless benchmark and trust gates pass.

## Non-Negotiable Rules

- Arabic Quran text is canonical, checksummed, and never machine-modified.
- Learner-performance AI output must include source references, calibrated confidence, component
  implementation/artifact/dataset attribution, review status, evidence ID, tenant ID, and audit
  event ID. Deterministic `text-rule` instruction must be explicitly instructional and must not
  invent confidence or review state.
- Audio retention defaults to `discard`; storage requires explicit learner consent.
- Agents are supervised tools. They may plan, explain, route, localize, and summarize, but they cannot issue unsourced religious answers.
- Institution data is tenant-scoped by default.

## Still Not Implemented

- Managed production deployment posture beyond the implemented restricted DB role/migration
  boundary: production secrets/origins, backups, complete observability, and branch-protected CI.
- Edition-level upstream attribution for Al Quran Cloud `quran-uthmani`; the provider names
  multiple upstream sources but does not publish an exact artifact mapping.
- Provisioned production object-storage infrastructure, credentials/rotation, lifecycle policy,
  monitoring, and a rehearsed S3 backup/restore/erasure drill. The application data plane is
  implemented; no managed bucket has been deployed or claimed by this repository.
- OpenAI Realtime/Agents SDK integration (the agents service and ASR are custom-built, not
  built on OpenAI's SDKs — ASR uses locally-run `openai-whisper` model weights only).
- Production institution auth provider/RBAC (OIDC/OAuth or equivalent), beyond the current
  JWT/login implementation.
- Live pilot usage with real learners at scale (the pilot tenant, seed data, and teacher/scholar
  review workflows exist and are exercised by integration tests, but this has not yet been used
  by real learners in the field).
- The Quran-tuned ASR model (`tarteel-ai/whisper-base-ar-quran`) is not actually running in the
  current deployment — it requires `transformers` as a new production dependency, a decision not
  yet made (see `ASR_MODEL` in `docker-compose.yml`).

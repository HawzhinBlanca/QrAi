# Testing

## The gate
`bash scripts/verify.sh` is the single source of "does it work". It runs:

1. **guard** — fails if any secret/protected file (`.env`, `secrets/`, `*.pem`) is tracked.
2. **lint** — `cargo fmt --check` + `cargo clippy -D warnings` for both Rust services.
   (TS has no separate linter; type safety is the TS lint, run next.)
3. **typecheck** — `tsc` for `@quran-ai/contracts`, `@quran-ai/quran-data`, `@quran-ai/server`, and
   `@quran-ai/web`.
4. **test** — vitest for the three TS packages; explicit `node --test` paths for server inference,
   API, job, contract, release, mobile-helper, and agents suites; Python ASR tests; and `cargo test`
   for both Rust services plus `shared-ticket`. The Flutter client is analyzed and tested when its
   SDK is installed and is skipped loudly otherwise. `tests/inference/golden-regression.test.mjs`
   computes alignment/Tajweed behavior against the real canonical Quran data rather than trusting
   a committed metric summary. Its fixture is mechanically ineligible for model evaluation,
   calibration, and release claims; this is regression proof, not acoustic-quality evidence.
5. **build** — `pnpm build` (contracts + quran-data + server + web).

`bash scripts/verify.sh --fast` runs only lint + typecheck (used by the PostToolUse hook).

The Node consolidation decisions have a permanent pre-implementation guard:

```bash
node --test tests/contract/node-backend-decisions.test.mjs
```

This is decision proof only. It requires ADR-0050, the matching living-architecture boundary, and
canonical invocation. It does not prove that the standalone package, S3 adapter, deadlines, rate
limits, enrollment, or process lifecycle have been implemented; each has a later behavioral gate.

W3.1 freezes the realtime architecture and Rust-generated wire truth with two hermetic gates:

```bash
node --test tests/contract/realtime-decisions.test.mjs
node --test tests/realtime/protocol-fixtures.test.mjs
```

The decision gate pins the isolated same-package process, Origin/native policy, benchmark-gated
Postgres nonce-hash proposal, fail-closed shared replay, bounded queues, and diagnostic-only ack
message. The fixture gate proves the single contracts-owned location, unchanged six-ticket oracle,
strict Node ack boundary, and accepted/rejected plus trace/null Rust vectors. Rust shared-ticket and
gateway tests and the Web parser independently consume the same documents. These gates do not
prove a listener, database replay implementation, load result, or traffic cutover.

W3.2 proves the isolated Node realtime process shell with one focused gate:

```bash
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" \
  node --test tests/realtime/process-lifecycle.test.mjs
```

Its hermetic cases prove side-effect-free import, strict process configuration, the exact
`/health`/`/ready`/`/metrics` surface, fail-closed private metrics, bounded dependency faults,
upgrade refusal, and API/realtime failure isolation. With Postgres reachable, the actual
`server/src/realtime/main.mjs` child boots under a freshly provisioned restricted role, reaches deep
readiness through real filesystem storage and live worker/ASR probes, then closes cleanly on
SIGTERM. A skipped live case is not restricted-role entrypoint proof. The production/release and
monitoring contracts additionally pin the third command to the same immutable Node image, with no
host port or traffic edge. This gate does not prove WebSocket admission, replay, audio queues, or
traffic cutover.

The Node package and standalone boundary have four focused gates:

```bash
pnpm --filter @quran-ai/server build
node --test \
  tests/node-api/standalone-lifecycle.test.mjs \
  tests/node-api/route-registry.test.mjs \
  tests/node-api/standalone.test.mjs \
  tests/node-api/production-image.test.mjs
```

`standalone-lifecycle` proves the ESM workspace/dependency boundary, side-effect-free composition,
local health construction, and close. `route-registry` proves one derived key projection matches the
manifest-approved executable transition set, with no duplicate allowlist. `standalone` proves every
executable route registers without an upstream, unknown routes remain local, and no-database pilot
identity fails closed instead of delegating. `production-image` pins the OCI base digest,
production-only deploy, non-root runtime, internal Compose compatibility topology, native
healthcheck, release digest lists, SBOM/licence inclusion, and Docker workflow. The separate Docker
workflow builds the real image, checks its filesystem/dependencies as the runtime user, and requires
its own `/health` transition to healthy. `/ready` requires Postgres; Web and realtime must still
target Rust until the later traffic-cutover tasks pass.

W2.14 private-audio lifecycle proof is split by what it can honestly establish:

- `tests/e2e/audio-lifecycle.test.mjs` is hermetic and canonical. It proves versioned server-derived
  keys, hostile-segment refusal, filesystem create-only/hash-idempotent behavior, interrupted-write
  inventory, S3 conditional puts/checksums/private metadata/AbortSignal, full pagination, HTTP-200
  partial-delete errors, verified idempotent erasure, and fail-closed production configuration.
- The worker inference suite proves the same injected store drives writes, reads, transcript
  assembly, privacy, and retention for filesystem and S3-shaped adapters while legacy filesystem
  objects remain readable.
- Live-Postgres parity tests prove changed index retries conflict, Node playback never uses the ML
  compatibility hop, export includes stored audio, delete removes it before the database cascade,
  tenant isolation holds, and a storage fault leaves the database untouched.
- `tests/e2e/teacher-audio-index.test.mjs` proves real gateway storage/index/playback and the
  dry-run/apply reconciler, including an ownership mismatch. Missing Postgres makes only these live
  tests skip through the canonical DB gate; the hermetic storage protocol tests never skip.

The ordered Node HTTP boundary has two additional hermetic gates:

```bash
node --test \
  tests/node-api/middleware-order.test.mjs \
  tests/security/node-boundary.test.mjs
```

They prove CORS/preflight → maintenance → rate admission → auth/handler ordering, fixed 429/503
responses, early-response metrics, exact maintenance probe exemptions, deterministic 200/50 ms
token-bucket refill, bounded idle/LRU key state, forwarded-IP spoof resistance, explicit trusted
hop behavior, 2 MiB/16 MiB body ceilings, and generic unexpected-error/credential redaction. The
full boot guard separately proves invalid or inert trusted-proxy hop configuration refuses to
listen. The exhaustive parity harness sets the same exact `DISABLE_RATE_LIMIT=1` as Rust so parity
remains behavior comparison rather than an accidental load test.

The Node database boundary has one hermetic and two live gates:

```bash
node --test tests/node-api/db-architecture.test.mjs
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test --test-concurrency=1 \
    tests/node-api/db-role-guard.test.mjs \
    tests/node-api/db-tenant.test.mjs
```

The architecture test permits database drivers only in `server/src/lib/db.mjs` and the three
operator scripts, rejects route-owned tenant GUC setup/raw transactions, and pins every unscoped
query to canonical Quran, readiness, or the locked-down pilot security-definer functions. The live
role test creates real restricted and `BYPASSRLS` logins and proves the Fastify pre-listen decision;
the tenant test proves GUC/timeout scope, failure cleanup, and interleaved pool isolation. A skipped
live suite is not database proof; canonical local evidence uses both an administrative migration URL
and the restricted stack URL.

Shared dependency deadlines have one adversarial suite:

```bash
node --test tests/faults/dependency-timeouts.test.mjs
DATABASE_URL="$RESTRICTED_URL" \
  node --test tests/faults/dependency-timeouts.test.mjs
```

The hermetic cases hang a response *after headers* and require the socket to close for
compatibility Rust, ML→ASR, and the agents worker; a status-only timeout test would miss an
unbounded response body. With live Postgres, the same suite proves server-side `57014`, HTTP 503 +
`Retry-After`, rollback of an insert preceding `pg_sleep`, privacy state preservation, and a review
audio audit that remains `attempted` rather than `served`. The live cases skip loudly when no
database is reachable; a skipped run is not database cancellation proof. The suite appears exactly
once in the canonical Node test invocation, asserted by `verify-invocations.test.mjs`.

Bounded API process drain has one real child-process suite:

```bash
node --test tests/node-api/graceful-shutdown.test.mjs
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test tests/node-api/graceful-shutdown.test.mjs
```

The hermetic run proves strict configuration refusal, first-signal admission stop, preservation of
a completing response, scheduled force-close of a hung dependency, repeated-signal escalation, and
a held upgraded socket that cannot defeat the hard grace. The live case gives the child a unique
Postgres `application_name`, forces a real readiness query, requires the pool to appear in
`pg_stat_activity`, and requires it to disappear after the ordered `resources closed`/`shutdown
complete` path. A skipped live case is not pool-drain proof. Production-image and invocation guards
also pin SIGTERM, the eight/ten-second app/container default inequality, and exactly one canonical
execution.

W2.15 durable work has four explicit proof layers:

```bash
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test tests/migrations/job-outbox-migration.test.mjs tests/jobs/durable-jobs.test.mjs
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test --test-concurrency=1 tests/e2e/durable-workflows.test.mjs
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test tests/node-api/worker-lifecycle.test.mjs
node --test tests/security/job-boundary.test.mjs
```

The migration/store suite proves forced RLS, restricted grants, idempotent enqueue races,
`SKIP LOCKED` claims, lease expiry and stale fencing, bounded retry/dead transition, exact-effect
completion, and immutable admin/ops replay. The workflow suite proves concurrent finalization and
Tajweed deduplication plus the privacy crash after object erase and before database commit. The
worker suite runs the real child against an isolated migrated database and proves strict config,
fair tenant polling, private metrics, readiness, SIGTERM drain, and pool exit. The security suite
recursively attacks payload/result bounds, fixed error/metric output, the recovery command, and the
offline evaluation/signing authority. Canonical invocation guards require every layer exactly once.
A skipped live suite is not durable-job proof.

W2.16 controlled device enrollment has one accepted live journey plus its migration, contract,
authorization, privacy, and secret-redaction callers in the ordinary canonical suite:

```bash
MIGRATION_TEST_ADMIN_URL="$ADMIN_URL" DATABASE_URL="$RESTRICTED_URL" \
  node --test --test-concurrency=1 tests/e2e/device-enrollment.test.mjs
```

The accepted journey uses a real restricted Postgres role and proves admin-only audited
provisioning, invitation reuse, expiry, forgery, refresh replay and whole-family revocation,
concurrent rotation, access expiry, explicit logout, current stored role, cross-tenant refusal,
hash-only persistence, fixed CLI failure output, count-only privacy export, and credential-row
deletion. `tests/migrations/device-identity-migration.test.mjs` separately pins forced RLS,
lineage/expiry constraints, hardened hash-discovery functions, grants, and schema convergence.
`tests/node-api/no-secret-logging.test.mjs` sends invitation/access/refresh canaries through real
requests, and `tests/node-api/production-image.test.mjs` requires Compose to pass
`DEVICE_IDENTITY_ENABLED` with a default of zero. A skipped database journey is not enrollment
proof; route activation and native Keychain/Keystore evidence remain separate owner/W4.10 gates.

W2.17 server-owned inference and one-image consolidation has a focused hermetic boundary:

```bash
node --experimental-strip-types --test \
  tests/contract/inference-module-boundary.test.mjs \
  tests/contract/inference-compatibility-surface.test.mjs \
  tests/contract/retired-components.test.mjs \
  tests/inference/compatibility-ingress.test.mjs \
  tests/jobs/local-inference-worker.test.mjs \
  tests/jobs/api-job-wait.test.mjs \
  tests/jobs/inference-cancellation.test.mjs \
  tests/node-api/production-image.test.mjs
```

These tests prove one server-owned inference module tree, API wait-only behavior, worker-only durable
execution, cancellation/fencing, a closed private compatibility surface, one Node image identity,
and removal of the former ML service/source/image. Live Postgres and real-process gateway callers
remain in the canonical gate; `node scripts/smoke-ml.mjs` and `node scripts/smoke-privacy.mjs`
exercise the running compatibility/data-lifecycle boundary. A green local gate is not remote CI,
staging replay, model-quality evidence, or a public traffic-cutover approval.

W2.18 explicit HTTP canary topology has a focused manifest/topology and effect boundary:

```bash
node --test \
  tests/contract/http-canary-topology.test.mjs \
  tests/e2e/http-canary-effects.test.mjs \
  tests/release/http-canary-image.test.mjs \
  scripts/load-test.test.mjs \
  tests/observability/http-canary-monitoring.test.mjs \
  tests/release/http-canary-controller.test.mjs \
  tests/release/canary-rollback-evidence.test.mjs
docker compose -f docker-compose.yml -f docker-compose.canary.yml config --quiet
```

The contract suite derives exactly 39 canary-owned routes from the route manifest, rejects count or
owner-gate drift, exercises the Web upstream allowlist, and pins paired base-Rust/canary-Node targets
for Web plus gateway indexing. The effect suite boots the real Node compatibility app: retained
health and mutable privacy requests stay local, while transition/Rust-only requests proxy exactly
once. A retained mutable request never reaches Rust. A proof-only owner header is enabled only by
`retained-canary` mode and absent from normal API
responses. The image contract requires exact candidate/previous digests, eight inspected container
identities, the rendered and running topology, the 39/4 route inventories, hostile/effect/privacy/
tenant/audio stages, a deliberate Rust-unavailable proof, guaranteed restoration, clean source,
write-once output, and 24-hour expiry. `scripts/http-canary-image.mjs` executes that proof against an
already-running immutable candidate stack and refuses a source-process or fixture substitute. The
load contract requires passed classroom, burst, and 30-minute soak artifacts with identical
candidate source, Node image, and topology identities. Monitoring tests pin five private scrapes,
low-cardinality alert thresholds, and dashboard queries. Controller tests prove healthy input has
no mutation or promotion authority, every stop signal reverses traffic then restores seven previous
application images, old database images are excluded, failure evidence is prefix-closed, and the
rollback effect/cleanup probe requires one stored effect, zero duplicates, and verified privacy
cleanup. `canary-rollback-evidence.test.mjs` also proves the release validator accepts only a fresh,
candidate-bound chain containing a signed 15-minute monitoring observation, the exact signed remote
check inventory, a healthy observation controller artifact, a completed `deliberate-drill`
rollback, and independent role-bound Ed25519 release-owner/security/SRE approvals. It rejects
tampering, missing checks, incident-only rollback, key-material reuse, stale evidence, and role
substitution. `verify.sh --release` validates those external documents before release work and
writes the closure artifact only after the full gate succeeds. The unit suite validates machinery
only; the real candidate/load/rollback timings, remote checks, and human decisions must still exist
externally and are never synthesized by tests.

Canonical Quran integrity is part of the ordinary TypeScript gate. For a focused review, run
`pnpm --dir packages/quran-data test` and
`node packages/quran-data/scripts/quran-content-hash.mjs`. The latter independently prints the
immutable legacy checksum plus provenance-v2's length-delimited ayah and word-token hashes; it
reads canonical files but never rewrites them. The production SQL generator performs the same v2
preflight before its first SQL output.

ASR readiness is also part of the ordinary gate through
`tests/inference/asr-readiness.test.mjs`. It exercises the stdlib-only production controller in
isolated Python subprocesses: unloaded, transient load failure/recovery, missing and wrong digest,
terminal no-reload behavior, probe failure/recovery, timeout, and exact synthetic fixture bytes.
For a focused run:

```bash
node --test tests/inference/asr-readiness.test.mjs
```

The production-container proof is separate from model evaluation. Build the ASR Dockerfile, start
it with the pinned `ASR_MODEL=base` and matching `ASR_MODEL_DIGEST`, and require `/health` 200 while
loading plus `/ready` 200 only after the cached probe. Repeat with a wrong digest and require
`/health` 200 plus `/ready` 503. Never treat the zero-signal probe transcript as model evidence.

ASR candidate identity and benchmark-input refusal are covered separately:

```bash
node --test tests/inference/asr-candidate-evidence.test.mjs
cd services/asr-inference
python3 -m pytest -q test_model_attribution.py
python3 candidate_evidence.py --registry model-candidates.json
```

These checks require a full Hugging Face commit, bind runtime configuration to the checked-in
candidate, verify downloaded artifact bytes, require complete approved slice evidence, and prove a
declared fixture cannot become selection evidence. They do **not** run a real benchmark. The registry
deliberately reports `blocked-no-eligible-benchmark`; no approved Kurdish held-out corpus exists yet.

Real word-span plumbing has a separate, deliberately non-evaluative proof:

```bash
node --test tests/inference/real-audio-spans.test.mjs
ASR_REAL_AUDIO_URL=http://127.0.0.1:8091 \
  ASR_API_KEY="$ASR_API_KEY" \
  node --test tests/inference/real-audio-spans.test.mjs
```

The ordinary gate checks the CC0 audio checksum and the captured response from the exact pinned
Whisper baseline. The second command is the live-worker leg and must run for W1.6 evidence; it sends
the same 92.72-second fixture to the configured ASR and requires positive monotonic word spans. Both
are plumbing checks only. The fixture is explicitly benchmark-ineligible, its transcript is not
reviewed Quran text, and neither command claims accuracy or clears the W1.5 selection gate.

`tests/inference/session-transcript.test.mjs` separately proves that stored PCM sessions over
the 120-second worker limit are split into bounded context windows, span offsets remain absolute,
legitimate repetitions survive overlap ownership, text-only ASR is force-aligned against the
recognized transcript, and incomplete/mixed/malformed evidence is refused rather than scored.

With live Postgres, the canonical gate also runs
`tests/e2e/real-audio-finalize.test.mjs`. It decodes the byte-pinned CC0 fixture to checksum-pinned
16 kHz mono PCM, replays the independently captured real-ASR spans through the actual ML process,
and drives the Rust finalizer into Postgres. It requires two bounded windows, exact source spans,
atomic refusal of malformed output, no row for omitted canonical words or extra ASR tokens, and
`transcript_source = 'server-derived'` for every persisted match/misread. The capture remains
benchmark-ineligible and this test makes no accuracy claim.

The adjacent `tests/e2e/model-provenance-roundtrip.test.mjs` uses the same shared actual-ML harness
through a transparent byte-preserving recorder. It compares the private transcript attribution with
the Quran-aligner input, then requires the inference component JSON, compatibility model, dataset,
latency, and evidence id to equal the tenant-bound `alignment_runs` row and every staff readback row.
It also proves the learner receives 403 and another tenant receives an empty result. Migration tests
separately prove the same-tenant/same-session composite FK and the new-row-only server-run check.

Tajweed instruction/performance separation is part of the ordinary Node gate and the live-Postgres
parity gate. Focused proof is:

```bash
node --experimental-strip-types --test \
  tests/contract/tajweed-analysis-basis.test.mjs \
  tests/contract/no-invented-confidence.test.mjs \
  tests/contract/ml-findings-shape.test.mjs

DATABASE_URL=postgresql://hawzhin@127.0.0.1:5433/quran_ai \
  node --test --test-concurrency=1 \
  tests/api-parity/review-parity.test.mjs \
  tests/api-parity/upstream-malformed.test.mjs \
  tests/api-parity/tajweed-persistence-effects.test.mjs
```

These checks require real deterministic output to contain instruction, reject invented confidence
in production and golden-fixture branches, refuse cross-contaminated upstream shapes, prove both
HTTP implementations exclude text rules from performance review, and verify no performance row or
false persistence audit is created. They do not claim acoustic Tajweed accuracy; that remains W1.10
and W1.11 evaluation work.

The W1.10 acoustic boundary has a separate focused gate:

```bash
python3 -m pytest -q \
  services/asr-inference/test_acoustic_tajweed.py \
  services/asr-inference/test_model_attribution.py
node --experimental-strip-types --test \
  tests/inference/acoustic-shadow.test.mjs \
  tests/inference/session-transcript.test.mjs \
  tests/inference/muaalem-candidate-evidence.test.mjs \
  tests/contract/acoustic-tajweed-boundary.test.mjs \
  tests/contract/retired-components.test.mjs
docker build --check --target default -f services/asr-inference/Dockerfile .
docker build --check --target acoustic-candidate -f services/asr-inference/Dockerfile .
```

Evaluation readback and smoke are evidence-aware rather than aggregate-authoritative. Focused proof:

```bash
node --experimental-strip-types --test \
  tests/inference/server.test.mjs \
  tests/contract/verify-invocations.test.mjs \
  tests/contract/openapi-completeness.test.mjs
DATABASE_URL=postgresql://quran_ai_app:REDACTED@127.0.0.1:5433/quran_ai \
  node --test --test-concurrency=1 tests/api-parity/reports-parity.test.mjs
node scripts/smoke-ml.mjs
```

The EvalRun response always includes explicit evidence kind, eligibility, release eligibility,
digests, signer data, counts, and slices; historical aggregate rows expose null provenance and
`fixture-regression`. Rust and Node are byte-compared with a complete non-release fixture. Browser
smoke returns a zeroed declared fixture and blocks every benchmark status. ML smoke runs the real
offline row evaluator, signs only with an ephemeral test key in memory, and verifies that the result
is cryptographically valid but never release-trusted. The online worker inference runtime has no
eval-run POST.

The ordinary gate uses a declared scorer double and proves byte-preserving QPS input, exact
candidate/profile identity, bounded windows, child restart/timeout, stored-audio/consent refusal,
server-owned spans, zero public findings, and no invented confidence. It also reproduces the CC0
correct/muted WAV pair byte-for-byte and checks its benchmark-ineligible evidence record. It does
not download 2.4 GB weights or claim model accuracy. The retired-component assertion additionally
keeps the superseded standalone service and its active topology claims out of the lean tree. The
vector test reads the manifest-bound mono 16 kHz PCM fixture, slices and mutes exact integer sample
ranges, and writes a fixed 44-byte WAV header with Node core only. It deliberately does not decode,
resample, filter, or mux through hosted-runner ffmpeg: encoder metadata and cross-build PCM rounding
are not protocol truth. The same byte assertion therefore runs hermetically in `ci/node-min` and
`ci/verify` without an image-owned executable or skip path.
The protected proof must explicitly build
`--target acoustic-candidate`, verify the embedded files, run both declared vectors without a
source-code mount, and record latency/memory. The pinned upstream decoder can place class ids in
the sifat probability field, so the adapter withholds all sifat numeric scores. These vectors
remain structural engineering proof—not error detection, a Kurdish-L1 accuracy benchmark, or
release approval.

The same Python acoustic test loads the production calibrator registry, proves it has no active
authority, and exercises a temporary approved record against exact scorer-artifact,
dataset-manifest, evaluation-evidence, artifact-size, and artifact-byte digests. Every mismatched
binding resolves unavailable. The Node acoustic-shadow test pins the empty production registry and
the runtime test still requires `findings: []`; these checks enable no calibrator and make no
calibration claim.

The offline evaluation authority is exercised without a model download or private corpus:

```bash
cd services/asr-inference
python3 test_eval_pipeline.py
```

The suite uses only declared test rows. It proves that `evaluate_candidate.py` recomputes known
metrics from exact row-level labels/scores, hashes every supplied artifact, emits deterministic
unsigned evidence, resamples reciters for uncertainty, and refuses summary-only input, non-finite
scores, class/reciter gaps, split leakage, mutable aliases, fixtures claiming release eligibility,
and incomplete release controls. It does not provide an approved calibrator or accuracy evidence.

Detached evidence verification is covered by the canonical Node contract suite. For a focused run:

```bash
node --test tests/release/model-evidence.test.mjs
```

It pins RFC 8785 number/string/property serialization, rejects non-JSON and malformed Unicode input,
re-hashes the exact evidence bytes, verifies Ed25519 signatures, and fails closed on tampering,
unknown/revoked/duplicate keys, duplicate public-key aliases, private JWK material, and test-key
release attempts. Test signatures use ephemeral process-local keys. The committed production trust
policy contains public JWKs only and intentionally starts with no keys, so local fixtures cannot
become release authority.

Release-claim selection and the shared numeric/provenance gate have focused proofs:

```bash
node --experimental-strip-types --test \
  tests/release/model-evidence.test.mjs \
  tests/release/model-claim-authority.test.mjs
node --experimental-strip-types scripts/check-model-eval-claims.mjs --self-test
```

The gate requires a verified release-class signature, exact payload/projection identities, a bound
calibrator, minimum row/reciter/slice counts, reciter-cluster bootstrap uncertainty, source-backed
acoustic findings, and task-specific metrics. The selector reads all rows rather than the newest;
fixture/research history is ignored, exact duplicate authorities collapse, and invalid or distinct
release-labelled identities fail closed. With the committed empty production trust policy, no model
may claim `eval-passed` or `released`.

The synchronized acoustic learner gate has one mutation corpus executed by TypeScript, Node, Rust,
and Flutter:

```bash
node --experimental-strip-types --test \
  tests/contract/learner-feedback-gate.test.mjs \
  tests/contract/tajweed-gate-parity.test.mjs
cargo test --manifest-path services/platform-api/Cargo.toml learner_gate --lib
cd apps/flutter && flutter test test/tajweed_gate_test.dart
```

The positive vectors require review, finite calibrated confidence, complete citations, a usable
retained-audio span/evidence id, exact model/dataset/calibrator/evaluation digests, release-trusted
evaluation status, and an audit id. Every field has a negative mutation. The committed production
trust and calibrator registries are empty, so declared DB fixtures are intentionally returned as
`fixture` + `uncalibrated` and remain withheld even after teacher acceptance.

Evaluation-evidence persistence has a disposable-database proof:

```bash
MIGRATION_TEST_ADMIN_URL=postgresql://admin@127.0.0.1:5432/postgres \
  node --test --test-concurrency=1 tests/migrations/eval-evidence-migration.test.mjs
```

The URL must name a disposable `CREATEDB`-capable test authority. The suite proves historical
aggregate rows are explicitly fixture-only, signed-evidence columns are complete-or-empty and
immutable, malformed digests/boolean-only promotion fail, finding attribution is a complete exact
same-tenant foreign key, unsupported historical model claims are demoted, and the existing forced
RLS policy hides another tenant's evidence. Its
inserted rows are declared database fixtures; they are not cryptographically valid model evidence.

> **verify.sh vs `pnpm test` / `pnpm proof`.** The two legacy commands run the platform-api
> integration tests with `--include-ignored` *unconditionally*, so they **fail** without a
> live Postgres. `verify.sh` is the gate that **skips** those tests when no DB is reachable
> (it never fakes them) — this matters for a local run with no Postgres started, not for CI:
> `.github/workflows/ci.yml` runs a real `postgres:16-alpine` service container and invokes the
> checksum-locked migration runner before `verify.sh` runs, so the DB-gated tests DO execute (and are asserted)
> in CI, same as a local run with Postgres up.
> `scripts/proof.sh` (`pnpm proof`, also what `scripts/smoke-all.mjs`'s first step runs) additionally
> runs the non-workspace Expo helper/typecheck and explicit inference/agents suites. `verify.sh`
> covers those same runtime boundaries plus the larger contract/job/parity corpus and conditionally
> runs Flutter analysis/tests when the SDK is installed. Neither command turns a missing Flutter
> SDK into device proof; native device validation remains a separate gate.

## Database-gated tests (platform-api)
`services/platform-api/tests/integration.rs` has tests marked
`#[ignore = "requires live Postgres"]`. The gate runs the infra-free tests always and runs
the ignored ones **only** when a live Postgres answers at `$DATABASE_URL` — otherwise it
prints a SKIP line. They are never faked. To include them:

```bash
docker compose up -d postgres          # postgres:16-alpine on :5432
docker compose run --rm migrations     # migrate, ledger, then provision quran_ai_app
bash scripts/verify.sh                 # now runs `cargo test ... -- --include-ignored`
# or point at any DB:
DATABASE_URL=postgresql://user@host:5432/db bash scripts/verify.sh
```

> **`cargo-mutants` against DB-touching code can leave garbage rows in a real local Postgres.**
> Mutation testing recompiles the source with one line mutated, then runs the *actual* integration
> test suite against `$DATABASE_URL` for real (not a mocked/rolled-back transaction) — that's the
> whole point, it needs to observe real behavior to know if a test catches the mutation. When a
> mutant disables input validation (e.g. `create_agent_run`'s reviewStatus/status allowlist check),
> a test asserting "invalid input is rejected with 400" still correctly marks that mutant CAUGHT
> (the assertion on the HTTP response fails), but the invalid row the mutated code accepted along
> the way is never rolled back or cleaned up — it's a real commit to a real table. Symptom: `pnpm
> smoke:sql`'s live check fails with a check-constraint violation from a migration replay (e.g.
> `agent_runs_review_status_check`) hitting a row like `review_status = 'not-a-real-review-status'`
> that no normal code path could ever have written. Fix: find and delete the offending row(s)
> (`SELECT id, review_status FROM agent_runs WHERE review_status NOT IN (...)`), not a code bug.

## Smoke tests (services)
`pnpm smoke:all` exercises the running stack (SQL/browser/API/worker-inference/privacy) and retains
artifacts under `out/smoke/`. These need services up (`docker compose up`) and are
**not** part of the ordinary `verify.sh` gate — they validate a deployed stack,
not just a code change. `bash scripts/verify.sh --release` is the stricter
release-only path: it requires a clean candidate, an explicit disposable
database, external artifact locations, release trace, environment identity,
and all deployable image digests before it runs the aggregate smoke. It writes
candidate-bound smoke/test/environment evidence only after the full gate
passes; it is not a substitute for protected CI or independent verification.

### Secure-stack smoke configuration

The running Platform API must use its restricted application `DATABASE_URL`.
The aggregate smoke resets and seeds a disposable database, which requires a
separate administrative connection. Set `SMOKE_DATABASE_ADMIN_URL` to that
disposable administrative URL before `pnpm smoke:all`; the runner uses it only
for reset/seed and SQL-RLS setup, while the Platform API retains its original
application URL. Do not grant truncate or ownership privileges to the
application role to make a smoke pass.

The aggregate runner honors `PSQL` when supplied and otherwise discovers the
standard Homebrew PostgreSQL 16 client path before falling back to `psql` on
`PATH`.

### Independent release challenge

`scripts/release-challenge.mjs` is the clean-checkout harness used after a
candidate manifest has been generated. It always re-verifies the signed
manifest from the supplied candidate checkout and requires its `--runner-id`
to differ from the build-provenance `builderId`.

`--verify-manifest-only` is useful for an adversarial manifest challenge, but
its external report is deliberately labeled `manifest-verified-only`; it is
not release proof. `--run-release` additionally requires a dedicated
`RELEASE_DATABASE_URL`, fresh external smoke/test/environment destinations,
image digests from the verified manifest, and a release trace. It reruns
`bash scripts/verify.sh --release` in the clean candidate checkout and writes
`status: "passed"` only when that complete rerun succeeds. The protected CI
job and an independently retained successful/adversarial run remain P0.7
requirements; the local harness does not claim they have happened.

## Verifying RLS enforcement (production posture)
The tenant-isolation policies (`infra/migrations/0003_tenant_rls.sql`,
`0009_learner_progress_rls.sql`) only bite when the connecting role is **not** a superuser
and lacks **BYPASSRLS**. The dev role (`hawzhin`) is a superuser and bypasses RLS, so in dev
isolation is enforced by the app-level `WHERE tenant_id = $1` clauses plus the per-request
`SET LOCAL app.tenant_id` that `begin_tenant_tx` applies. To prove RLS itself is the backstop,
run the API as the restricted role:

```bash
# 1. Apply migrations and provision the restricted role with an administrative connection.
MIGRATION_DATABASE_URL="$SUPERUSER_URL" node server/scripts/migrate.mjs
MIGRATION_DATABASE_URL="$SUPERUSER_URL" APP_DATABASE_PASSWORD="$STRONG_PASSWORD" \
  node server/scripts/provision-role.mjs

# 2. Run platform-api as that role and smoke it.
DATABASE_URL="postgresql://quran_ai_app:$STRONG_PASSWORD@localhost:5432/quran_ai" \
ALLOW_HEADER_AUTH=1 ALLOW_INSECURE_SECRETS=1 JWT_SECRET=dev PLATFORM_API_BIND=127.0.0.1:8085 \
  ./services/platform-api/target/debug/quran-ai-platform-api &
PLATFORM_API_SMOKE_URL=http://127.0.0.1:8085 node scripts/smoke-api.mjs
```

Expected: `status:"pass"`, `sameTenant:200`, `otherTenant:404` (cross-tenant read blocked by
RLS, not just by the WHERE clause), and no unexpected 500s. The `SET LOCAL app.bypass_rls`
escape hatch is ignored for non-superuser roles, so the app role stays subject to the policies
even if that custom GUC is set.

The **live SQL RLS smoke** proves the policies in isolation without the app:

```bash
POSTGRES_RLS_SMOKE_URL="$DATABASE_URL" node scripts/smoke-sql.mjs
# -> live.status "passed", 15 tenant tables (see `tenantTables` in scripts/smoke-sql.mjs
# for the current list — it's grown since this doc was first written), transaction-rollback mode
```

## The Flutter client (`apps/flutter`)

```bash
cd apps/flutter && flutter test        # widget + unit, no device, no network
cd apps/flutter && dart analyze --fatal-infos
```

`verify.sh` runs both — and **SKIPS them loudly when `flutter` is not on PATH**, which is the state
of a runner that has not installed the SDK. That skip is why the client's contract test lives in
`tests/contract/flutter-contract.test.mjs` (Node) rather than in Dart: it compares `models.dart` and
`api_client.dart` against `packages/contracts/openapi.yaml` in **both** directions — the keys the
client reads against the response schema, and the bodies it posts against the `requestBody` — and it
runs whether or not the SDK is present. It also pins the platform microphone declarations, because
`flutter create` does not add them and a regeneration that dropped them would build, launch, pass
every widget test, and record nothing.

The shared boundary has two additional hermetic proofs:

- `tests/contract/openapi-completeness.test.mjs` derives the current 42-operation set from the Rust
  router, compares it with both OpenAPI and `packages/contracts/route-manifest.json`, computes the
  retained/retired/added target, rejects permissive inference envelopes, and validates responses
  from the real Node ML producers.
- `packages/contracts/tests/model-attribution.test.ts` and the Node/Python runtime suites pin the
  five-component vocabulary, exact SHA-256 syntax, primary/legacy binding, unavailable-component
  honesty, and the negative unknown/mismatched-digest cases. Database-backed
  `ml-asr-proxy-parity.test.mjs` then proves both public proxy implementations reject invalid
  producer attribution and all client-selected model identities.
- `tests/contract/retired-routes.test.mjs` pins the four ADR-0038 retirements and inventories every
  transitional production caller. A route cannot disappear from the current contract merely
  because it is absent from the final target, and removal stays blocked until caller count is zero.

Hardware is faked at the seam, never stubbed into green:

| what | how it is driven | what the test can then assert |
|---|---|---|
| microphone | `PcmStreamFactory` injected into `StreamingRecorder` | that the socket opens **first**, and that a refused ticket opens no microphone at all |
| gateway socket | `SocketFactory` | that captured frames reach the sink byte-identically |
| HTTP | `MockClient` (`package:http/testing`) | that the consent the learner gave is what reached the wire |
| secure storage | `FlutterSecureStorage.setMockInitialValues` | that a token never lands anywhere else |

**Running it on a device is `FL9` and is still open** — `flutter test` is not device proof, and the
web build this repo can produce is not either.

### Against a live stack

`test/live_gateway_test.dart` runs the client's real transport against a real `realtime-gateway`
with a real ticket. It is gated on `QRAI_LIVE_TICKET` and skips otherwise, so `verify.sh` is
unaffected. Full recipe and output:
[`specs/migration-completion/evidence/live-gateway-e2e.md`](../specs/migration-completion/evidence/live-gateway-e2e.md).

> **Deployment requirement, found by running it.** A gateway serving the Flutter client must set
> **`GATEWAY_ALLOW_MISSING_ORIGIN=1`**. Browsers always send `Origin` on a WebSocket upgrade and
> native clients never do, so without it the gateway fails closed and **every recitation is a 403**.
> It relaxes only that branch — a request that does carry an Origin is still checked against the
> allowlist. The gateway must also be pinned to the serving tenant with `GATEWAY_TENANT_ID`.

`tests/e2e/teacher-audio-index.test.mjs` is the database-backed topology proof. It runs a real
gateway, the shared filesystem development adapter, platform-api and WebSocket; verifies the
resulting index and audited teacher playback bytes; forces an index outage; checks the
stored-unindexed metric; runs the storage-neutral repair command first in dry-run and then apply
mode; proves idempotence; and refuses stored metadata whose learner disagrees with the authoritative
tenant-scoped session. `verify.sh` runs it whenever the
live-Postgres leg is available and cannot silently skip it inside that leg.

## Conventions
- Every spec.md acceptance criterion (EARS) maps to ≥1 automated test that runs in `verify.sh`.
- Property/fuzz tests for pure logic (parsers, checksums, contracts) where cheap.
- DB/network/service-dependent tests are gated behind availability, never stubbed to fake green.

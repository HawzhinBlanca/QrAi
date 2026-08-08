# Plan — professional consolidation to the final lean Flutter + Node app

**Status:** APPROVED — implementation proceeds one task at a time<br>
**Approved-by:** Repository owner (user instruction: "proceed")<br>
**Approval date:** 2026-08-06<br>
**Approved scope/decisions:** W0–W7 and decisions 1–9<br>

Read `research.md`, `audit-2026-08-06.md`, `spec.md`, and `impact-map.md` first. Per `AGENTS.md`, no implementation or deletion begins until the human fills the approval lines above.

## 1. Recommended decisions included in approval

Approval of this plan accepts these architectural decisions unless the owner edits this section first:

1. **Consolidate in this repository.** No greenfield rewrite and no second repository.
2. **Flutter becomes the sole product client** for Android, iOS, and Web. React remains frozen only until minimum parity is proven.
3. **One modular Node package becomes the application backend.** It has separately deployable API, realtime, and worker entrypoints from one dependency boundary; CPU-heavy inference and realtime backpressure never share the API event loop.
4. **Retire public password register/login.** Continue the owner-gated login-off posture and use controlled single-use invitation/device enrollment. Admin/teacher/scholar identities are provisioned, never self-selected. This supersedes Proposed ADR-0025.
5. **Retire the standalone agents product and its two API operations.** Preserve only domain logic that proves useful inside ordinary Node jobs.
6. **Postgres is the durability primitive.** Use RLS, a migration ledger, a transactional outbox/job table, and durable ticket replay/index records; do not add Redis or NATS to the lean v1.
7. **Use private object storage for retained audio.** Filesystem storage remains test/dev only.
8. **Python ASR is evaluation-gated.** It stays as one isolated worker until a Node/ONNX or on-device replacement passes the same real-audio benchmark. “Only two languages” is not allowed to reduce Quran accuracy.
9. **Historical specs are removed from the active branch after cutover.** A migration summary and Git commits preserve the record; no `legacy/` folder is created.

Each architectural decision or new runtime dependency receives an ADR before the implementation task that depends on it.

## 2. Final tracked source tree

```text
apps/
  flutter/                         # Android, iOS and Web product
server/
  package.json                     # one Node dependency boundary
  src/
    app.mjs                        # composition root
    api/                           # REST registry, middleware, handlers
    realtime/                      # WebSocket/audio boundary
    domain/                        # recitation/progress/review/privacy/approval
    inference/                     # alignment/Tajweed orchestration
    storage/                       # Postgres + object-store adapters
    workers/                       # CPU and background work entrypoints
  scripts/migrate.mjs              # sole migration runner
packages/
  contracts/                       # OpenAPI, shared fixtures, generated-client inputs
  quran-data/                      # immutable canonical/reviewed bundles
inference/
  asr/                             # temporary isolated worker, if benchmark winner
infra/
  migrations/                      # ordered SQL + checksums
  monitoring/
tests/
  contract/ e2e/ faults/ realtime/ release/ security/
scripts/
docs/
  architecture.md decisions.md testing.md operations.md migration-summary.md
specs/
  constitution.md
  lean-flutter-node-consolidation/ # active program until completion
```

The final deploy can have an API/realtime process and a worker process. That is one Node backend codebase, not a microservice collection. Postgres and object storage are infrastructure, not duplicated application stacks.

## 3. Delivery discipline for every task

Every task below follows this exact loop:

1. Find the existing symbol and all callers with Serena; update `impact-map.md` if reality differs.
2. Add or change the named automated test first and observe the expected failure.
3. Make the smallest implementation change within the approved task.
4. Run the focused test.
5. Run `bash scripts/verify.sh`; release-only tasks also run `bash scripts/verify.sh --release` in protected CI.
6. Only after a zero exit and green required CI checks, update `tasks.md` through `scripts/update-ledger.sh`.

No task weakens an assertion, disables a test, changes canonical bytes in place, or marks itself complete by judgment.

## 4. Wave 0 — make the evidence trustworthy

**Purpose:** repair the instruments before using them to authorize deletion.

### W0.1 Route inventory

- Replace the comment-sensitive parsing in `tests/contract/lib/openapi.mjs::routePairsFromRust` with a parser/fixture that recognizes the actual 42 pairs.
- Pin the two currently invisible audio routes in `tests/contract/route-inventory.test.mjs`.
- Correct `tests/contract/coverage.test.mjs`, `scripts/cutover-readiness.mjs`, OpenAPI counts, and all stale 38/40-route documentation.
- Make the current Rust set an immutable migration baseline fixture before any retirement.

**Criteria/tests:** CT-1, CT-2.<br>
**Exit:** the checker reports 42/42 current operations and the old false-green test fails under a mutation that restores the broken parser.

### W0.2 Target contract and route retirement ADR

- Write an ADR accepting controlled device enrollment and retiring `POST /v1/auth/register`, `POST /v1/auth/login`, and both `/v1/agent-runs` operations from the final contract.
- Produce an explicit baseline-derived manifest: 42 current operations, four deliberately retired, and 38 retained baseline operations. The final target count is then generated after adding the separately specified enrollment and learner-history operations; it is never inferred by subtraction or maintained by hand.
- Move the former Flutter-local OpenAPI file into `packages/contracts/openapi.yaml` and add schemas for the two missing audio routes plus the three currently `x-unvalidated` operations.
- Select and ADR the OpenAPI-to-Dart generation tool before adding it.

**Criteria/tests:** CT-2, CT-3, CT-4.<br>
**Exit:** baseline and target counts are distinct and mechanically checked; nothing disappears through parser behavior.

### W0.3 One migration system

- Relocate numbered SQL into `infra/migrations/` without changing SQL bytes or ordering.
- Add `server/scripts/migrate.mjs` using the existing Postgres client, a `schema_migrations` ledger, SHA-256 checksums, `pg_advisory_lock`, transactions, and fail-closed checksum drift.
- Separate immutable migrations, seed data, and role provisioning.
- Make Compose, CI, local bootstrap, staging, restore, and release call this runner.
- Add fresh-schema and previous-schema equivalence tests through migration `0027` before any new migration.

**Criteria/tests:** DB-1, DB-3.<br>
**Exit:** empty and upgraded databases have the same fingerprint; no Compose init mount is the migration mechanism.

### W0.4 Repair the current audio index topology

- Wire the existing gateway's `PLATFORM_API_URL` in the transitional Compose stack.
- Prove chunk storage → API index → teacher playback before touching gateway language.
- Add actionable orphan-index metrics and a repair command that never guesses tenant ownership.

**Criteria/tests:** RT-4.<br>
**Exit:** the current topology no longer stores undiscoverable retained audio.

## 5. Wave 1 — make the Quran-learning result real

This wave precedes backend deletion. Rewriting a broken result in Node would only preserve the defect.

### W1.1 Canonical provenance

- Correct the `alquran.cloud` versus `tanzil` source mismatch without mutating canonical text.
- Record the direct provider, edition, terms, unresolved exact upstream, and additive source-id migration.

### W1.2 Length-delimited corpus integrity

- Preserve the legacy `surah:ayah:text\n` checksum and immutable `provenance-v1.json`; add a self-contained `provenance-v2.json` that supersedes and checksum-pins v1.
- Define one domain-separated SHA-256 framing: UTF-8 fields and records prefixed by unsigned 64-bit big-endian byte lengths; ayah fields are `(surah, ayah, text)` and token fields are `(surah, ayah, wordIndex, text)` in canonical order.
- Add pure hash computation over supplied surahs plus a full-bundle wrapper; validate both v2 hashes, exact counts, source, edition, import version, and the 1:1 U+FEFF reconstruction exception without trimming or normalization.
- Make `write-full-quran-sql-seed.mjs` complete the full v2 integrity preflight before emitting its first SQL byte; keep `toCanonicalSqlSeed` and database schema unchanged.
- Extend the independent hash regenerator and prove that a same-count token mutation changes only the token hash, while every DB-seed bundle remains byte-equal to its source JSON.

**Files/symbols:** `packages/quran-data/src/full-quran.ts::{FullQuranManifest,computeFullQuranIntegrityHashes,validateFullQuranIntegrity}`, `packages/quran-data/src/index.ts::buildFullQuranSurahBundle`, `packages/quran-data/scripts/{quran-content-hash,write-full-quran-sql-seed}.mjs`, versioned provenance manifests.<br>
**Criteria/tests:** QA-1 maps to `corpus-provenance.test.ts`, `full-quran.test.ts`, `full-quran-checksum-integrity.test.ts`, `quran-import.test.ts`, and `nfc-invariant.test.ts` inside `scripts/verify.sh`.

### W1.3 Server-authoritative component attribution

- Add a closed component contract for `asr`, `forced-aligner`, `quran-aligner`, `acoustic-scorer`, and `calibrator`.
- Require every active component record to name its producing implementation, `sha256:` artifact digest, dataset version, analysis basis, and optional calibrator id. An unavailable component has no artifact and cannot support a learner-facing claim.
- Bind the legacy `modelVersion` compatibility label to the primary component record while it remains on the wire; reject unknown components, malformed or mismatched digests, duplicate component records, and legacy-label disagreement.
- Make the ML/ASR producer author the attribution. Public proxy and session/alignment requests do not select a model; session persistence reuses the server-selected session identity rather than a request value or `model-v0.3` fallback.
- Do not invent checkpoint digests. Repository algorithms may use the exact implementation-file digest; externally loaded artifacts need a real resolved digest or remain unavailable until W1.4/W1.5.
- Keep database component persistence out of this task; W1.8 adds the additive storage/readback shape once real spans exist.

**Files/symbols:** `packages/contracts/src/index.ts`, `packages/contracts/openapi.yaml`, `services/ml-inference/server.mjs::{predictAlignment,predictTajweed}`, `services/asr-inference/server.py` response models, Node/Rust ML proxies and session writers, Flutter session request.
**Criteria/tests:** QA-6 contract/producer tests, including unknown component, mismatched digest, legacy-label mismatch, and caller-selected model refusal.

### W1.4 ASR liveness, readiness, and recovery

- Move model load/probe work off the ASGI thread behind one lock-protected controller: `/health`
  stays process-only and fast while `/ready` is 503 until load, digest validation, and probe succeed.
- Require `ASR_MODEL_DIGEST`; resolve the selected component attribution and compare the configured
  digest before admitting traffic. The current Compose `base` checkpoint is pinned to the digest in
  Whisper's verified download URL; W1.5 remains responsible for evaluating and selecting a winner.
- Run one declared, deterministic, short zero-signal WAV fixture through the loaded inference path.
  Validate only structural execution, never transcript accuracy; cache the result and enforce a
  probe deadline without launching overlapping workers or rerunning inference on each `/ready` call.
- Retry a failed load/probe through one bounded background worker so a transient failure can recover.
  Inference routes use the same ready state, while failure responses expose a safe reason code and
  full exceptions remain operator logs only. Shutdown stops retry waits without blocking process exit.
- Change Compose to probe `/ready`, copy the controller into the image, wait for ASR readiness in
  staging, and add the readiness suite to the canonical gate. Record the startup change in ADR-0044.
- Prove unloaded, load-failed, missing/wrong digest, probe-timeout/failure, single-worker behavior,
  and fail-then-recover cases with isolated subprocess fixtures; run the same cases against the
  production container wiring and retain the result without presenting fixture output as model proof.

**Files/symbols:** `services/asr-inference/readiness.py` (new controller),
`server.py::{_load_model,require_loaded_model,current_asr_attribution,health}` plus new lifespan and
`ready`, `Dockerfile`, `docker-compose.yml`, `scripts/recreate-staging.sh`, `scripts/verify.sh`,
`docs/{DECISIONS,TESTING}.md`, architecture and W1.4 evidence.
**Criteria/tests:** QA-8 and the ASR slice of OP-4 map to
`tests/inference/asr-readiness.test.mjs`; W6.3 retains the whole-system DB/object-store/capacity gate.

### W1.5 Immutable candidates and honest benchmark selection

- Treat the approved Kurdish ASR protocol and consented, sealed held-out corpus as preconditions,
  not files engineering may invent. Until owner, scholar, legal/privacy, and data approvals exist,
  the only valid selection status is `blocked-no-eligible-benchmark`; the current Compose model is
  an operational placeholder, not a reviewed winner.
- Add a small checked-in candidate registry. Every runnable candidate names its runtime, immutable
  upstream identity, full revision where applicable, exact artifact digest, training-data disclosure,
  license review state, and adapter/output capability. Mutable revisions such as `main`, `latest`, a
  branch, or an unqualified Hugging Face repository id are structurally ineligible.
- Keep OpenAI Whisper `base` at its verified checkpoint digest as the baseline. Register the Tarteel
  Quran model only at its full upstream commit and require the downloaded snapshot/weight digest to
  match before execution. Record pronunciation-detection models as research-only unless an exact,
  licensed deployable artifact and adapter exist; a paper result or model-card number is not a
  production candidate.
- For Hugging Face execution, require `ASR_MODEL_REVISION` as a 40-character lowercase commit hash,
  pass it to the loader, and include it in component attribution. A declared digest without an
  immutable revision cannot qualify as the artifact that produced evidence.
- Add a candidate-evidence validator for W1.5 selection input. It requires exact candidate registry
  identity, artifact/runtime-lock/image digests, sealed dataset-manifest and evaluator digests,
  source commit, measured-versus-fixture eligibility, required accent/age/device/noise slices,
  per-slice sample counts and metrics, and bounded latency/memory/image-size measurements. Thresholds
  come only from the approved protocol; this task does not invent them.
- The validator emits/refuses selection eligibility but does not sign a release. Fixtures, synthetic
  readiness audio, copied metrics, incomplete slice matrices, candidate mismatches, or missing review
  approvals must fail closed. W1.12 recomputes and signs final release evidence using the same exact
  candidate and dataset identities.
- Run benchmark tooling only against read-only consented data outside the repository, never log raw
  audio, and write aggregate evidence plus content-addressed manifests. Compare all eligible candidates
  on the identical reciter-disjoint held-out manifest; do not tune on held-out output.
- Pin a winner in the image only after every approved primary and safety threshold passes, independent
  review names the exact evidence digest, the production image proves the same artifact, and the full
  gate is green. Otherwise preserve the prior placeholder with learner performance feedback withheld.

**Files/symbols:** `services/asr-inference/model-candidates.json`, new candidate-evidence validator,
`model_attribution.py::build_asr_attribution`, `server.py::{_load_model,current_asr_attribution}`,
ASR image/Compose configuration, W1.5 evidence and selection status.
**Criteria/tests:** QA-7 and QA-8 map to `tests/inference/asr-candidate-evidence.test.mjs`, existing
attribution/readiness tests, candidate mutation cases, and the canonical gate. The human-gated real
benchmark remains explicitly blocked until its prerequisites exist.

### Approved dependency amendment — 2026-08-07

- **Approved-by:** repository owner through the persistent instruction to continue completing the
  approved consolidation program.
- W1.5 remains open until a consented, sealed Kurdish-L1 corpus and the required independent reviews
  exist. No fixture, public recitation, model-card metric, or engineering test may clear that gate.
- W1.6 onward may proceed because measured-span transport, refusal safety, contract truth, and backend
  consolidation do not depend on declaring an accuracy winner.
- Learner-performance feedback remains withheld wherever the missing W1.5/W1.10/W1.11 evidence gates
  are not satisfied. The operational Whisper baseline is not renamed or advertised as selected.

### W1.6 Real word spans

- Define a measured recognized-token shape `{text,startMs,endMs,confidence}`. Accept only finite,
  non-negative, strictly positive spans; preserve the ASR's Quran bytes without normalization.
- Make `transcribeSession` compose bounded PCM windows below the worker's 120-second cap. Each request
  includes bounded context, but midpoint-to-core ownership selects output so absolute offsets remain
  monotonic without text deduplication deleting legitimate Quran repetitions.
- Where ASR lacks usable timestamps, force-align that window's recognized transcript against the
  same audio. Never force-align the canonical passage, and refuse if word identity/count or spans do
  not correspond exactly.
- Refuse incomplete audio, mixed/invalid sample rates, malformed or unavailable spans, window failure,
  and word/duration limits with an explicit reason. A partial transcript is not finalizable evidence.
- Preserve transitional `recognizedText` only as a projection of `recognizedTokens`; the tokens are
  the server-derived authority used by W1.7.
- Test the window/core/offset/refusal logic hermetically and run the exact path against a checksum-
  pinned, redistributable real recitation fixture. The fixture proves plumbing, never model accuracy.

**Files/symbols:** `services/ml-inference/server.mjs::{transcribeAudio,transcribeSession,recognizedTokensFrom}`
plus the recognized-transcript force-align helper and the real-audio fixture manifest.<br>
**Criteria/tests:** QA-2 maps to `services/ml-inference/session-transcript.test.mjs` and
`tests/inference/real-audio-spans.test.mjs`.

### W1.7 Evidence-backed Quran mapping

- Extend `alignWords` to consume measured recognized tokens while preserving its string-call
  compatibility during migration. A matched/misread/extra result carries only its source token's
  measured span; a missed canonical word has no span.
- Make `predictAlignment` accept trusted server-derived tokens, strip internal mapping indices from
  the public response, and return an explicit non-finalizable result if any claimed recognized token
  lacks valid evidence.
- Update transitional Rust finalization and the Node replacement to pass tokens rather than a bare
  text array and persist only valid canonical matched/misread rows. Never persist extras or misses as
  evidence-backed alignments.

**Files/symbols:** `services/ml-inference/alignment.js::alignWords`,
`server.mjs::predictAlignment`, Rust `finalize_session`, final Node finalize handler, strict OpenAPI.<br>
**Criteria/tests:** QA-2 maps to alignment span tests and `tests/e2e/real-audio-finalize.test.mjs`.

### W1.8 Provenance round trip

- Compose transcript attribution across bounded windows: every repeated component must be identical;
  a force-aligner component augments (never replaces) ASR; a conflict or missing producer record
  refuses finalizable output. Forward the validated transcript attribution only on the private
  finalize path and reject that field on public Rust/Node proxies.
- Compose Quran alignment attribution from the exact transcript records plus the repository-digested
  Quran aligner. Use the canonical-corpus component dataset on real output; reserve the declared
  smoke dataset label for explicit fixture mode.
- Add migration `0029` with one runtime-selected alignment registry row, nullable run provenance on
  the already-RLS-protected `alignment_runs`, and a tenant-bound nullable FK from
  `word_alignments`. Enforce new server-derived rows having a run link without fabricating links for
  historical rows.
- Insert the run and all word rows in the same restricted tenant transaction. Persist response
  evidence id, dataset, latency, consent snapshot, transcript source, and the validated full
  component document. Refuse session/producer disagreement and roll back the whole write.
- Extend the existing staff-only alignment read with exact run provenance. Legacy/client rows return
  `null` attribution/dataset and empty evidence ids; no default producer is substituted. Keep Rust
  and the transitional Node reader byte-identical.
- Keep the Node finalizer itself in W2.6. W1.8 ports the read shape now and records the Rust finalize
  test as explicit deferred parity rather than claiming a route that does not exist.

**Files/symbols:** `model-attribution.mjs` composition helper;
`server.mjs::{transcribeSession,predictAlignment}`; migration `0029`; Rust
`require_producer_attribution`, `finalize_session`, `persist_alignments_in_tx`, and
`list_session_alignments`; Node `listSessionAlignments`; strict OpenAPI/contracts.<br>
**Criteria/tests:** QA-2 and QA-6 map to component-conflict/missing-attribution unit tests,
`model-provenance-roundtrip.test.mjs`, migration/RLS/schema-equivalence proof, and Rust/Node read
parity.

### W1.9–W1.11 Separate instruction from performance judgment

- Preserve canonical-text Tajweed rules as instructional annotations labeled `analysisBasis=text-rule` with no learner-performance confidence.
- Produce learner-performance findings only from time-linked acoustic evidence.
- Choose one bounded acoustic implementation for the pilot; quarantine neural experiments until evaluated.
- Calibrate confidence on the held-out evaluation set; never map heuristic energy/F0 scores directly to release confidence.

**Files/symbols:** `services/ml-inference/tajweed.js::{analyzeWord,analyzeAyah}`, ASR acoustic analysis, finding contracts, persistence and Flutter models.<br>
**Criteria/tests:** QA-3, QA-4, QA-5.

#### W1.9 implementation boundary

- Rename the deterministic producer concept from finding to annotation: return canonical rule
  occurrences in `annotations[]` with literal `analysisBasis='text-rule'` and
  `instructional=true`; omit performance confidence, severity, and review state. Keep
  `findings[]` exclusively for acoustic learner judgments and return it empty until W1.10.
- Apply the same classification to declared golden-fixture Tajweed output. Fixture decimals must
  not survive into either annotations or learner-performance fields.
- Validate that separation at both Rust and Node trust boundaries before persistence or learner
  redaction. A text-rule item in `findings`, an acoustic item in `annotations`, or any annotation
  carrying confidence/review/severity fails closed as an invalid upstream response.
- Add migration 0030: use `text-rule | acoustic`, make historical text-rule confidence null, and
  enforce null confidence for text rules versus non-null confidence for acoustic findings. Keep
  historical rows for audit, but exclude text rules from performance review and learner-feedback
  reads; reject attempts to approve one as a learner judgment.
- Update strict OpenAPI/contracts and the active Flutter client so confidence is required only on
  acoustic findings. The practice flow may ignore instructional annotations until a dedicated
  teaching surface exists, but it must never parse or display one as feedback about recitation.
- Prove the result with `tajweed-analysis-basis.test.mjs`, `no-invented-confidence.test.mjs`,
  producer regressions, migration convergence, Rust/Node response-and-effect parity, and Dart gate
  tests.

#### W1.10 implementation boundary — approval amendment

**Status:** APPROVED FOR IMPLEMENTATION — shadow evaluation only; learner feedback remains gated.<br>
**W1.10 Approved-by:** Repository owner (persistent instruction: "Continue completing till fully implemented as top high end system fully robust")<br>
**Decision requested:** approve the pinned Muaalem v3.2 shadow candidate, the existing-worker
integration, and the upstream-default Hafs 4/4/4/4 profile for non-learner-facing evaluation only.

- Select `obadx/muaalem-model-v3_2` for **shadow evaluation**, not release, at immutable Hub revision
  `01a1ef9fbe40d144ef845101e89ff924aed3fef5` and safetensors SHA-256
  `6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41`.
  Bind the official package source commit `2e444e040516781ecef72fe9bbc513bb34dedad4`
  and `quran-transcript` commit `fb64a1a8b0d7f5c38ffe26de0c69cc4a2b840950`.
- Add an acoustic candidate manifest whose release status remains blocked by independent model/data
  licence review, a scholar-reviewed recitation profile, an adjudicated held-out corpus, W1.11
  calibration, W1.12 evaluation, latency/memory proof, and candidate-bound approvals. Newer 2026
  repositories with no config/weights remain ineligible rather than being selected by recency.
- Keep one inference boundary. Fold the selected adapter into `services/asr-inference` and run the
  heavy model in one bounded, restartable child worker so a load/crash cannot take ASR liveness with
  it. Do not add the disconnected `tajweed-neural` service to Compose or the public API. The normal
  image may omit the shadow artifact; the candidate image must bundle and verify it before ready.
- Build QPS only from server-authoritative canonical words. Use the upstream default candidate
  profile (`hafs`, `murattal`, madd 4/4/4/4), assign it a versioned profile id and checksum, and label
  it pending scholar approval. Call `quran_phonetizer` directly; never use upstream `Aya`/Tanzil
  data, `normalize_aya`, Unicode normalization, or a canonical write. Bind every observation to the
  canonical token hash, profile id, QPS-builder revision, and derived-reference digest.
- Replace the current Python duration/F0/energy/centroid route with a private bounded observation
  route. Validate 16 kHz mono PCM, complete `0 <= startMs < endMs` word spans, session bounds,
  maximum 15-second context windows, finite model output, exact reference correspondence, and model
  attribution. Use overlapping context words but commit observations only for each window's core
  words so boundaries and repeated words cannot duplicate claims.
- In Rust `proxy_ml` and Node `proxyMl`, reject caller-supplied `learnerId` and acoustic segments;
  overwrite any request Quran reference/source checksum with the stored session values; inject the
  server-owned learner id and only same-tenant, same-session, server-derived matched/misread spans.
  Spanless, client-reported, stale-run, foreign-session, or missing audio must yield no observation.
- Extract the complete PCM timeline loader already used by `transcribeSession` and reuse it from
  `predictTajweed`; do not create a second storage/audio assembly path. Honor the stored consent and
  retention state, never log raw audio, and make missing/gapped/mixed-rate/expired audio explicit.
- Keep acoustic output internal in W1.10. The ML orchestrator may record status, producer attribution,
  raw observation count, evidence id, and refusal reason in structured audit metadata; it must not
  copy raw CTC softmax values into `confidence`, `findings[]`, Postgres, teacher review, Flutter, or
  learner responses. Public `findings[]` remains empty until W1.11 promotes calibrated observations.
- Test first: add candidate/digest/profile refusal tests; Python reference/window/model-adapter tests;
  Node ML stored-audio/refusal tests; and Rust/Node hostile-input/effect parity. The ordinary gate
  uses a declared scorer double. Protected candidate proof must run the exact bundled artifact on a
  licensed real recitation plus an explicitly declared altered-audio error vector and report
  latency/memory; neither vector is accuracy or release evidence.
- After the selected adapter passes the focused and canonical gates, remove the zero-caller heuristic
  implementation and `services/tajweed-neural` code/docs/locks. A zero-caller inventory and retired-
  component assertion must prove no command, import, Compose/release target, or living doc keeps the
  obsolete implementations active.

**Exact implementation surface:** `services/asr-inference/{server.py,model_attribution.py,
acoustic_tajweed.py,acoustic-candidates.json,Dockerfile,requirements.lock.txt}`;
`services/ml-inference/server.mjs`; Rust `handlers/ml_proxy.rs::proxy_ml`; Node
`routes/ml-proxy.mjs::proxyMl`; strict internal fixtures; `docs/{DECISIONS.md,DATA_LICENSES.md,
architecture/10-10-platform.md,TESTING.md}`; removal of `services/tajweed-neural` only after proof.

**Criterion-to-test map:** QA-3 → `tests/contract/acoustic-tajweed-boundary.test.mjs`,
`services/asr-inference/test_acoustic_tajweed.py`, and
`tests/api-parity/tajweed-acoustic-inputs.test.mjs`; QA-5 →
`tests/contract/no-invented-confidence.test.mjs` plus the ML uncalibrated-withholding case; QA-6 →
`tests/inference/muaalem-candidate-evidence.test.mjs` and exact observation attribution round-trip.
The exact-model container vector runs from `verify.sh --release`; W1.10 stays unchecked until that
proof, the canonical gate, and required CI are green.

### W1.12–W1.13 Real evaluation

- Replace copied release metrics with a reproducible evaluator that writes candidate-bound evidence.
- Keep declared fixtures only for deterministic regression and label them so they cannot pass the release gate.
- Make `golden-regression.test.mjs` part of canonical verification, while keeping its claim limited to regression behavior.

**Criteria/tests:** QA-6, QA-7.<br>
**Exit for Wave 1:** one declared real-audio fixture finalizes into timed evidence and the learner gate behaves correctly; this does not by itself claim production accuracy.

## 6. Wave 2 — converge onto one production Node backend

### W2.1 Create the Node package boundary

- Create `server/package.json` and add it to `pnpm-workspace.yaml`.
- Move root runtime dependencies used only by Node from `devDependencies` into the server package.
- Move `services/node-api` and load-bearing `services/ml-inference` modules incrementally, preserving imports and tests per task.
- Add lint/typechecking policy; keep ESM and Node 22.13.1 as the minimum until an upgrade ADR.
- Add a non-root multi-stage Dockerfile, Compose service, health/readiness, and release-image entry.

**Criteria/tests:** BE-1, OP-1, OP-2.

### W2.2 Make the backend standalone

- Port the three retained Rust-only operations: audio chunk indexing, session finalization, and learner session findings.
- Remove the production requirement for `PLATFORM_API_UPSTREAM`; retain the proxy only in a test/canary compatibility entrypoint until Rust retirement.
- Remove agent-run routes and password routes only after the accepted target-contract migration proves no caller.
- Require every tenant path to use `withTenant`; forbid raw DB imports in route/domain modules.

**Criteria/tests:** BE-1, CT-4, DB-2.

### W2.3 Production middleware and lifecycle

- Port maintenance mode, rate limiting, trusted-origin handling, trace/metrics order, request/body limits, error redaction, and metrics access policy.
- Add boot checks for restricted DB role, secrets, origins, object storage, and model configuration.
- Add `AbortSignal` budgets and cancellation propagation to Postgres/object store/ASR/worker calls.
- Add graceful HTTP/WebSocket drain and DB/worker shutdown.

**Criteria/tests:** BE-3, BE-4, BE-5, OP-4.

### W2.4 Durable storage and jobs

- Add an object-store interface with S3-compatible production and filesystem test/dev implementations.
- Bind object keys to server-derived tenant/learner/session/chunk identities.
- Implement idempotent write/read/export/delete and orphan reconciliation.
- Use a Postgres outbox/job table for finalize/evaluation/retry work; no new message broker.

**Criteria/tests:** BE-6, DB-2.

### W2.5 Controlled enrollment

- Extend the existing invitation boundary into one-time device enrollment.
- Store release credentials only through Flutter secure storage.
- Provide rotation, revocation, idle/absolute expiry, and admin-provisioned staff roles.
- Remove the Proposed bcrypt dependency ADR after the retirement ADR is accepted.

**Criteria/tests:** BE-2, FL-6.

## 7. Wave 3 — port realtime into the Node codebase

### W3.1 Protocol and security parity

**Approved decomposition (2026-08-08):** the owner-approved W3.1 child plan and the master ledger
split this original coarse slice across W3.1–W3.4. W3.1 accepts the decision and freezes the shared
ticket/ack fixtures only. The realtime entrypoint is W3.2, admission checks are W3.3, and durable
replay plus its Postgres benchmark are W3.4. This allocation supersedes the bullet grouping below;
it does not weaken or remove any requirement.

- Move the ticket wire contract into language-neutral fixtures and a Node realtime module.
- Implement WebSocket upgrade, origin/no-Origin native policy, tenant/session binding, expiration, retention claims, and single-use replay protection.
- Store consumed nonce hashes durably in Postgres with a unique constraint and TTL cleanup; never store raw tickets.
- Run the Node implementation against all Rust ticket/gateway hostile-input vectors.

**Criteria/tests:** RT-1.

### W3.2 Bounded audio pipeline

- Implement per-session bounded queues, maximum frame/payload sizes, backpressure acknowledgments, ordered sequence numbers, and bounded retries.
- Write audio to object storage and index it transactionally/idempotently through the Node domain layer.
- Track stored-but-unindexed and accepted-but-lost chunks separately.
- Keep CPU processing on workers; the socket loop only validates, queues, stores, and acknowledges.

**Criteria/tests:** RT-2, RT-3, RT-4.

### W3.3 Reconnect and fallback

- Define reconnect ticket issuance, exponential backoff/jitter, local buffer ceiling, and session finalization fallback.
- A buffer overflow or exhausted reconnect must stop recording and explain loss; it may not silently drop frames.
- Port chaos, long-audio, hostile-input, retention, and index-failure tests before enabling Node realtime.

**Criteria/tests:** RT-3.<br>
**Exit for Wave 3:** the Rust gateway remains the oracle until Node passes parity, fault, load, and canary gates.

## 8. Wave 4 — finish one Kurdish-first Flutter product

### W4.1 Information architecture and generated contract

- Generate Dart request/response models and the API client from the approved OpenAPI contract.
- Replace handwritten route/model drift incrementally; retain Quran-byte and feedback-gate fixtures in Dart tests.
- Reduce the final role-based navigation to learner, teacher review, scholar/source approval, privacy, and essential settings.

**Criteria/tests:** CT-3, FL-2.

### W4.2 Reviewed Sorani and Arabic

- Introduce ARB bundles and a capability manifest with reviewer, source, version, completion, and expiry.
- Translate every critical journey and domain term; do not advertise a locale until key parity and human review pass.
- Treat the current partial Sorani Quran translation coverage (Surahs 1, 2, and 78–114) as a release blocker for any full-Quran translation claim; acquire and review a licensed complete corpus or accurately constrain the advertised coverage.
- Keep canonical Arabic Quran text outside localization and force its correct RTL rendering independently.

**Criteria/tests:** FL-1, FL-2.

### W4.3 Complete learner loop

- Connect reader selection directly to practice.
- Add licensed reference recitation and word highlighting.
- Implement listen, guided recitation, recording, correction, focused drill, and completion without ornamental gamification.
- Persist progress idempotently and show the server-calculated next review.
- Add delayed reviewed-feedback inbox/history with clear pending/approved/blocked states.

**Criteria/tests:** FL-3, FL-4, FL-5.

### W4.4 Teacher and scholar loop

- Add paginated teacher queue with learner/session context, retained-audio status/playback, evidence spans, sources, confidence basis, and accept/reject/edit.
- Persist edited wording separately and never promote the discarded original.
- Extend scholar approvals with an immutable target identity/content hash and a server-derived pending-candidate queue before building the UI.
- Add the minimal scholar approval surface with source scope, risk refusal, audit id, and immutable decision history; do not ship a free-text approval form disconnected from a finding, rule, model, or content candidate.

**Criteria/tests:** FL-7, FL-8.

### W4.5 Device resilience and release

- Complete consent, permission, interruption, background, offline, reconnect, buffer, cancellation, and privacy states.
- Produce signed Android/iOS/Web candidates.
- Run the physical device/OS/network/accessibility matrix and attach signed evidence to the candidate.

**Criteria/tests:** FL-9, FL-10, GOV-1.<br>
**Exit for Wave 4:** Flutter demonstrably replaces the minimum React product, not every old dashboard.

## 9. Wave 5 — ASR decision and production proof

### W5.1 ASR production capacity and long-audio policy

- Revalidate the W1 loaded-model readiness probe inside the final production image.
- Prove bounded request windows with absolute offsets for sessions beyond 120 seconds and declare worker concurrency, queue, overload, and recovery limits.
- Run capacity/fault evidence against the exact pinned candidate rather than a development model alias.

**Criteria/tests:** QA-8, OP-4.

### W5.2 Node/ONNX versus Python decision

- Export/evaluate a Node/ONNX or on-device candidate using the same held-out real-audio corpus.
- Compare word error/alignment error, Tajweed task metrics, calibration, latency, memory, battery/device coverage, privacy, and licensing.
- If it passes every approved non-inferiority threshold, move inference to Node/on-device and remove Python.
- If it does not, retain one isolated Python worker and record the explicit exception; do not falsify a “Node-only” result.

**Criteria/tests:** QA-7, QA-8.

## 10. Wave 6 — canary, cutover, and rollback

### W6.1 Candidate-bound final topology

- Make root `dev`, `build`, `test`, `typecheck`, `proof`, Compose, reverse proxy, CI, release images, SBOM, license checks, smokes, load tests, and runbooks target Flutter/Node/inference.
- Create immutable Node and Flutter artifacts with digests and migration/model identities.
- Require deep readiness and observability before receiving traffic.

**Criteria/tests:** OP-1, OP-2, OP-4.

### W6.2 Shadow and canary

- Shadow safe read traffic and compare responses/effects without duplicate writes.
- Canary by bounded cohort, not random untraceable percentage.
- Monitor SLOs, privacy lifecycle, tenant isolation, lost chunks, feedback withholding, model drift, and support signals.
- Automate stop conditions; do not automate the human GO decision.

**Criteria/tests:** OP-3, GOV-1.

### W6.3 Rollback/restore/sign-off

- Rehearse application rollback, migration compatibility, object-store recovery, privacy job retry, and timed Postgres restore.
- Obtain independent security, privacy, scholar, accessibility, mobile, SRE, and product signatures for the exact candidate.
- Keep Rust/React immutable rollback artifacts through the observation window.

**Criteria/tests:** OP-3, GOV-1.<br>
**Exit:** final topology is serving the bounded pilot, release evidence is green, and rollback has been exercised.

## 11. Wave 7 — delete obsolete structures and leave a lean repository

Deletion is one component at a time. Each task begins with a reference inventory, removes the component plus all current callers/configuration, runs focused tests, then the full gate.

### W7.1 Remove Expo

- Delete `apps/mobile`, `.github/workflows/mobile.yml`, its proof/verify blocks, dependencies, and living-document references.
- Preserve no copy under another directory.

### W7.2 Remove disconnected experiments

- Delete `services/tajweed-neural` unless W5 selected it through real evaluation.
- Remove the standalone `services/agents`; migrate only explicitly retained domain functions into Node jobs.
- Remove research-only ASR Tajweed/forced-alignment endpoints not selected by W1/W5.
- Audit and, with a backup/retention decision, drop unused `agent_runs`/`alignment_runs` schema only if no durable product or legal need remains.

### W7.3 Remove React

- Delete `apps/web`, Vite/React dependencies, nginx web image/config, browser-only smoke/security scripts, and React release artifacts.
- Replace browser/a11y/security coverage with Flutter Web and API/reverse-proxy equivalents before deletion.

### W7.4 Remove the Rust platform API

- After a Node HTTP canary, soak, rollback rehearsal, and at least one retained rollback window, delete `services/platform-api` without waiting for the realtime port.
- Convert Rust-oracle API parity tests into permanent contract/effect regressions before deleting the oracle; update root commands, Compose, CI, release images, reverse proxy, and runbooks.
- Keep `services/shared-ticket` while the Rust realtime gateway still imports it.

### W7.5 Remove the Rust realtime gateway and final Cargo boundary

- After an independent Node realtime canary, soak, and rollback rehearsal, delete `services/realtime-gateway` and then `services/shared-ticket`.
- Preserve language-neutral ticket/audio acknowledgment fixtures, hostile-input cases, and observable metric contracts as permanent regressions.
- Remove Cargo toolchain steps and Rust dependency audits/licenses only when no Cargo crate remains.

### W7.6 Collapse Node and repository layout

- Complete the move from `services/node-api` and `services/ml-inference` into `server/`; remove empty transitional directories.
- Consolidate monitoring, migration, contract, and smoke scripts into their final locations.
- Replace fragmented living docs with the five final documents listed in the target tree.
- Write `docs/migration-summary.md`, inventory completed specs and their commit ids, then remove obsolete active spec directories.
- Add a lean-tree guard. Do not create `legacy/`.

**Criteria/tests:** CL-1, CL-2, CL-3, CL-4, OP-1.<br>
**Exit:** `rg` finds no executable/current reference to Expo, React, Rust, retired agents, or retired neural experiments; the final verification and release gate pass from a clean clone.

## 12. Verification strategy

### Per task

- The named focused test from `spec.md`.
- `bash scripts/verify.sh`.
- Ledger update only after both are green.

### Per wave

- Clean-clone CI on Node 22.13.1 and the pinned Flutter/Dart toolchain.
- Live restricted-role Postgres integration tests.
- Migration fresh/upgrade equivalence.
- Contract/OpenAPI/Dart-client parity.
- Negative/mutation test proving the new gate can fail.

### Release/cutover

- `bash scripts/verify.sh --release` in protected CI.
- Signed device/model/security/privacy/operations evidence.
- Full-stack smoke, long audio, load/burst, reconnect, dependency fault, privacy lifecycle, restore, and rollback.
- No required check skipped.

## 13. Rollback boundaries

| Wave | Rollback |
|---|---|
| W0 | Revert tooling/config; no product data shape changes until migration equivalence is proven |
| W1 | Model/feature flag back to withheld feedback; never revert canonical bundles in place |
| W2 | Route/cohort returns to Rust oracle; forward-compatible migrations remain |
| W3 | WebSocket endpoint returns to Rust gateway; tickets remain cross-compatible during observation |
| W4 | Cohort stays on frozen React/previous Flutter candidate; server contract remains compatible |
| W5 | Restore prior model artifact by digest; evaluation evidence identifies the exact rollback model |
| W6 | Immutable application/model artifacts plus rehearsed DB/object-store procedure |
| W7 | Git revert is possible until observation-window sign-off; deletion starts only after replacement evidence expires no sooner than the rollback window |

No destructive database drop occurs in the same release that removes its last writer/reader. Deprecate, observe, back up, then drop in a later migration.

## 14. Effort and ownership estimate

These are engineering ranges, not promises. They assume one task at a time per repository but allow specialist review in parallel.

| Workstream | Estimated engineering effort | Required specialist input |
|---|---:|---|
| Evidence, contract, migrations | 2–3 weeks | backend/security |
| Real alignment/Tajweed/evaluation | 4–8 weeks | ML, Quran/Tajweed scholar, data governance |
| Node API/storage convergence | 4–6 weeks | backend/SRE/security |
| Node realtime | 3–5 weeks | realtime/SRE/security |
| Flutter product + Kurdish/Arabic | 6–10 weeks | Flutter, Sorani/Arabic reviewers, UX/accessibility |
| ASR benchmark/decision | 3–6 weeks | ML/device/privacy |
| Canary, release, cleanup | 3–5 weeks | SRE/security/privacy/mobile/product |

Likely calendar with a small competent team: **14–22 weeks**. A single engineer should plan for **25–40 engineer-weeks**. Compressing this by deleting or self-signing gates would produce a smaller repository, not a professional product.

## 15. Risks and controls

| Risk | Control |
|---|---|
| Route or feature disappears during cleanup | 42-route baseline, 38 retained baseline operations, explicit additions/retirements, generated contract, caller inventory |
| Port preserves a broken learner loop | W1 real-audio evidence before W2/W3 deletion work |
| Quran bytes/tokenization drift | versioned bundle, ayah + word-token hashes, NFC invariant |
| Node weakens Rust security | parity + mutation + RLS-role + middleware/lifecycle fault tests |
| One Node process blocks on inference | worker entrypoint/thread/process with bounded queue and cancellation |
| Flutter reproduces web complexity | minimum-role product scope; do not port decorative dashboards |
| Kurdish claim outruns review | locale capability manifest and fail-closed key/reviewer tests |
| Python removed for aesthetics | benchmarked non-inferiority gate |
| Cleanup destroys user/local artifacts | only tracked, enumerated component paths are in scope; backups/caches require separate explicit approval |
| Specs are deleted before knowledge transfer | migration summary + commit inventory + unresolved decisions first |

## 16. Approval gate

To approve implementation, fill the header:

```text
Approved-by: <repository owner>
Approval date: <YYYY-MM-DD>
Approved scope/decisions: W0–W7 and decisions 1–9, or list edits
```

After approval, implementation starts with **W0.1 only**, adds its failing test first, runs the canonical gate, and stops if the repository reality differs from `impact-map.md`.

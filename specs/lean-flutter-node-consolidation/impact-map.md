# Impact map — lean Flutter + Node consolidation

**Status:** approved; implementation proceeds one verified ledger task at a time
**Scope:** callers, contracts, tests, deployment surfaces, and retirement gates affected by W0–W7

## 1. Mapping method and limits

- Serena symbol search and reference search were used during earlier indexed TypeScript/JavaScript
  passes. Serena was unavailable for W1.6, so that pass used repository-wide exact-name/import `rg`
  plus direct source inspection and records the fallback rather than claiming missing tool evidence.
- Rust, Dart, Python, YAML, SQL, shell, and dynamic JavaScript registration were also traced with exact-name/import/config searches because Serena does not resolve every language or dynamic route table in this repository.
- The map records known callers, not permission to change all of them in one task. Before changing a symbol, the implementation task must rerun reference discovery and update this file if the repository has moved.
- A deletion gate includes imports, commands, CI, images, Compose, reverse proxy, smokes, release evidence, living docs, and rollback artifacts—not merely source callers.

## 2. Program dependency graph

```text
route inventory + migration truth
              |
              +--> real alignment/Tajweed/evaluation proof
              |
              +--> deployable Node API --> retained API parity --> HTTP canary
                                                        |              |
                                                        |              +--> retire platform-api
                                                        |
                                                        +--> Node realtime parity --> realtime canary
                                                                                         |
                                                                                         +--> retire gateway/shared-ticket

Flutter contract/localization/product work runs against the retained contract,
then Flutter replaces Expo and finally React only after role and release parity.
```

The HTTP and realtime retirements are independent. The Rust platform API can be retired after the HTTP observation window while the Rust gateway and `shared-ticket` remain. Combining them would create a flag-day rewrite.

## 3. Contract, route inventory, and migrations

| Symbol or boundary | Known callers/consumers | Planned change | Proof before callers move |
|---|---|---|---|
| `tests/contract/lib/openapi.mjs::routePairsFromRust` | `tests/contract/coverage.test.mjs`; `scripts/cutover-readiness.mjs::{main,checkTrafficShare,checkOracleCoverage,checkSchemaValidation}` | Replace the comment-sensitive matcher with lexical comment handling; pin the true 42-route baseline | Parser fixtures for line/block comments; explicit assertions for `GET /v1/tajweed-findings/{id}/audio` and `POST /v1/audio-chunks`; mutation catches the old false-green behavior |
| `packages/contracts/openapi.yaml` | `scripts/{validate-openapi-responses,cutover-readiness}.mjs`; `tests/api-parity/lib/contract.mjs`; `tests/contract/{coverage,flutter-contract,enum-parity,enum-db-parity}.test.mjs`; `apps/flutter/lib/src/api/models.dart` and `services/node-api/routes/index.mjs` documentation; future Dart generator | Relocate the former Flutter-local contract into this permanent package boundary; update every executable consumer in the same task; close the `predictTajweed`, FastAPI `TranscribeResponse`, and FastAPI `ForceAlignResponse` permissive responses | `openapi-completeness.test.mjs`; existing response validation; Flutter model-contract checks |
| `services/ml-inference/server.mjs::predictTajweed` response | route dispatcher; Rust/Node ML proxy pass-through; `persist_tajweed_findings`; Flutter `TajweedFinding`; ML/server and API-parity tests | Contract the producer's response envelope, finding fields, source fields, and provenance fields without changing inference output | strict response schema compilation; producer fixture validation; existing ML finding-shape and Flutter model tests |
| `services/asr-inference/server.py::{TranscribeResponse,ForceAlignResponse}` | FastAPI route decorators; Rust/Node ASR proxy pass-through; ML session transcription; API-parity tests | Mirror the Pydantic response models as strict OpenAPI schemas without changing canonical text or inference | schema fixture validation for transcript words and aligned words; zero `x-unvalidated` operations |
| final route inventory | current Rust router; future Node route registry; OpenAPI; Flutter generator | Record the immutable 42-operation baseline, four approved retirements, 38 retained baseline operations, and separately named target additions in `packages/contracts/route-manifest.json` | `retired-routes.test.mjs`; `openapi-completeness.test.mjs`; set arithmetic and exact-name assertions |
| `services/node-api/server.mjs::PORTABLE` | `buildServer`; its own startup validation; cutover configuration | Eliminate as a second hand-maintained route truth after the target registry is generated/validated | `route-registry.test.mjs`; Node registry equals the approved target contract |
| `services/node-api/routes/index.mjs::ROUTES` | `buildServer`; Node route modules | Become the sole runtime registration composition derived against OpenAPI | Route/effect parity, hostile input, and auth matrix |
| 26 numbered SQL files `0001`–`0027` (no `0014`) | `docker-compose.yml` mounts 20 numbered files through `0021` in an order that differs from the filenames, then separately mounts role provisioning; `.github/workflows/ci.yml` owns a separate 26-file loop through `0027`; `scripts/smoke-all.mjs` and `scripts/smoke-sql.mjs` read selected files; `scripts/recreate-staging.sh` inherits Compose; `scripts/restore-db.sh` restores without forward migration; `scripts/verify.sh --release` assumes a pre-migrated database; Rust and Node DB handlers consume the result | Move every numbered file byte-identically to `infra/migrations`; pin source checksums in a manifest; add one `server/scripts/migrate.mjs` runner with a database ledger, session advisory lock, per-migration transactions, exact legacy-baseline adoption, idempotence, and fail-closed drift; keep role provisioning under `infra/provision` and canonical/full-corpus seeds under their existing data package boundary | Hermetic manifest/checksum tests; live fresh/`0021`-upgrade/legacy-`0027` equivalence; idempotence/concurrency/rollback/drift tests; Compose dependency contract; restricted role remains login/non-superuser/non-`BYPASSRLS` with table/function grants |
| `GatewayServerConfig::platform_api_url`, `handle_audio_socket`, `record_index_failure`, and `render_prometheus` | Compose `realtime-gateway`; ML `/v1/audio-chunks` storage; Rust `index_audio_chunk`; finding-audio handlers in Rust and Node; gateway unit/index-failure/retention E2E; platform audio-index/playback parity; operators scraping `/metrics` | Wire the transitional gateway to the internal platform API; distinguish configured indexing from stored-but-unindexed outcomes; retain failed audio; add an explicit repair command that reads storage sidecars but accepts tenant/learner ownership only after a tenant-scoped database match | Real storage → gateway index → teacher playback E2E; disabled/failed index metric assertions; idempotent repair; path/metadata/session-owner mismatch refusal; existing retention, index-failure, audio-index, playback, tenant/RLS, and privacy tests |
| `lost_chunk_count`, `transcript_source`, `reviewed_finding`, `superseded_at`, `analysis_basis`, span/evidence constraints | Rust finalize, alignment writers, review/realignment, weekly progress, Node parity code | Preserve through additive migrations readable by both binaries during the strangler | Schema fingerprint and live DB parity on both implementations |

Baseline arithmetic is explicit: 42 current operations; four accepted retirements (`register`, `login`, and two `agent-runs` operations); 38 retained baseline operations. Device enrollment, device-session refresh/revocation, and learner history are separately named additions, so the final count is generated from the manifest rather than typed independently.

W0.3 keeps the historical data-bearing files `0002`, `0006`, and `0007` in the immutable ordered migration chain because they have already shipped under those ids. “Separate seed data” means no new environment seed is smuggled into the migration runner: the complete canonical corpus continues to come from `packages/quran-data`, while role creation/password rotation is a separate provision command. Migrations run with an owner/admin connection; application processes continue to use the separately provisioned `quran_ai_app` role, which is explicitly stripped of superuser and `BYPASSRLS` privileges.

## 4. Quran data, alignment, Tajweed, and evaluation

| Symbol or boundary | Known callers/consumers | Planned change | Proof/gate |
|---|---|---|---|
| `CanonicalAyahRecord.sourceId`, `CanonicalWordRecord.sourceId`, `CanonicalSourceManifest.id` | checksum payload/build/verification functions in `packages/contracts/src/index.ts`; Quran bundle builders; contract fixtures | Add the direct acquisition identity `alquran-cloud`; retain existing identities for historical/fixture bundles | contract typecheck/tests; `corpus-provenance.test.ts` |
| `packages/quran-data/src/index.ts::CANONICAL_SOURCE_MANIFESTS` | `getCanonicalSourceManifest`; `quran-import.test.ts`; full-corpus bundle/seed construction | Register Al Quran Cloud `quran-uthmani` as the full-corpus acquisition source; do not infer an exact Tanzil upstream identity from provider-level terms | source registry assertions; byte-identical old/new source bundle comparison |
| `packages/quran-data/scripts/write-full-quran-sql-seed.mjs` | `scripts/seed-full-quran-to-db.sh`; operator full-corpus seed path | Replace the incorrect hard-coded `tanzil` label with the reviewed full-corpus source constant; source/checksum metadata changes, Arabic text does not | generator source assertion; corpus provenance and checksum tests |
| `canonical_ayahs_source_id_check` in `infra/migrations/0001_core_schema.sql` | every canonical ayah insert/update; full-corpus seed generator; Rust/Node Quran readers | Preserve historical migration bytes and add migration `0028` expanding the allowed source ids to `alquran-cloud`, `quran-foundation`, and `tanzil` | provenance migration assertion; manifest checksum; fresh/0021/0027 schema equivalence; live full-corpus seed |
| migration-plan count/final schema in `tests/migrations/{migration-runner,schema-equivalence}.test.mjs` | `server/scripts/migrate.mjs`; canonical `verify.sh` live DB gate | Keep the 26 historical checksums pinned while treating `0028` as a new additive migration; legacy 0027 adoption applies 0028 rather than inventing it as historical | migration runner/concurrency/rollback/drift and three-path schema fingerprint equality |
| `packages/quran-data/src/full-quran.ts::{FULL_QURAN_MANIFEST,computeFullQuranContentHash,validateFullQuranIntegrity}` | full-Quran and provenance tests; integrity validation | Preserve the legacy byte hash; load immutable provenance v2; add domain-separated length-delimited ayah/token hashes and validate source/version/count/hash agreement | provenance v1 immutability + v2 schema/hash assertions; same-count token mutation; existing structural/content tests |
| `packages/quran-data/src/full-quran.ts::{computeQuranIntegrityHashes,computeFullQuranIntegrityHashes}` (new) | integrity validation; hash regenerator parity test; corpus provenance/full-Quran tests | Hash UTF-8 bytes with unsigned 64-bit big-endian field and record lengths; coordinates and token indices are explicit; never trim or normalize | exact pinned hashes, framing metadata, order mutation, token-only mutation, U+FEFF preservation |
| `packages/quran-data/src/index.ts::buildFullQuranSurahBundle` | `corpus-provenance.test.ts`; `full-quran-checksum-integrity.test.ts`; `write-full-quran-sql-seed.mjs` found by exact-name search | Keep the builder unchanged; prove every emitted ayah/token text is byte-equal to the source stream represented by provenance v2 | all 114 bundles, 6,236 ayahs, 82,456 tokens, row checksum verification and seed equality |
| `packages/quran-data/scripts/write-full-quran-sql-seed.mjs` | package `seed:full-quran:sql`; `seed-full-quran-to-db.sh`; `scripts/smoke-all.mjs`; operator seed path | Run full provenance-v2 integrity validation before emitting any SQL, then use the existing bundle/SQL functions | generator preflight assertion; full bundle equality; live seed in canonical gate |
| `packages/quran-data/scripts/quran-content-hash.mjs` | deliberate operator regeneration only; documented by `full-quran.ts` | Independently print the legacy and v2 ayah/token hashes with counts and framing identity | script-output parity against runtime constants; no canonical writes |
| word-token and Alafasy timing bundles | integrity tests; future Flutter timing loader; reference-audio controller | Pin a word-token serialization hash and a reviewed timing/audio identity | Token reconstruction test without `.normalize()`; timing/audio parity tests |
| `services/ml-inference/server.mjs::transcribeAudio` and new `recognizedTokensFrom` | `predictAlignment`; `transcribeSession`; route dispatcher; `server.test.mjs`; `session-transcript.test.mjs` | Validate and preserve ASR text/start/end/probability as measured millisecond tokens; project text without normalization; reject malformed spans | positive/zero/reversed/non-finite span cases; declared real-audio fixture; timeout/readiness tests |
| component-attribution contract and validator (new) | ML/ASR response contracts; Node/Rust proxy validation; W1.8 persistence; W1.11 learner gate | Closed five-component vocabulary; active records require implementation/artifact/dataset/basis; bind the compatibility label and reject unknown/mismatched records | contract mutation tests for unknown component, malformed/mismatched digest, duplicate record, unavailable artifact, and label disagreement |
| `services/ml-inference/server.mjs::{MODEL_VERSION,predictAlignment,predictTajweed}` | route dispatcher; ML server/audit tests; Node/Rust ML proxies | Replace the free/fallback global label with server-authored component attribution derived from the exact producing implementation; retain only a derived compatibility label | ML producer tests; OpenAPI response validation; no caller-selected model test |
| `services/asr-inference/server.py::{TranscribeResponse,ForceAlignResponse,TajweedAnalysisResponse}` | direct ASR routes; Node/Rust ASR proxies; ML `transcribeAudio`; ASR OpenAPI schemas | Return component attribution for the actual ASR, forced aligner, and acoustic scorer; never name an unavailable calibrator or unresolved external artifact as active | Python response/unit tests; OpenAPI contract; unresolved artifact refusal |
| `server.py::_load_model` and new `AsrReadinessController` | module startup/lifespan; `require_loaded_model`; `/ready`; transcribe and acoustic routes | Load and probe in one background worker, validate the configured digest, retry without overlap, and publish an immutable ready snapshot | `asr-readiness.test.mjs`: loading, failure, digest, timeout, single-worker, recovery vectors |
| `server.py::{health,ready,require_loaded_model}` | Compose healthcheck; staging recreation; every ASR-backed inference route; ML/platform/Node proxy callers | Keep `/health` process-only; make `/ready` and route admission share loaded+digest+probe state with safe reason codes | HTTP/subprocess contract assertions plus production-container health-state proof |
| ASR Docker/Compose readiness wiring | `ml-inference.depends_on`; staging startup; release image; operators | Copy the readiness module, pin the selected `base` digest, switch healthcheck to `/ready`, and make staging wait for it | Compose/config assertions; unloaded/failed/wrong-digest/replacement-recovery container cases |
| `model_attribution.py::build_asr_attribution` | `server.py::current_asr_attribution`; readiness expected-digest comparison; transcribe response attribution; Python attribution/readiness tests | Require a full immutable HF commit revision and bind it into `implementationId`; bare OpenAI checkpoints remain bound to their verified download digest | HF alias/missing/branch revision refusal, exact commit acceptance, digest mismatch, existing OpenAI checkpoint vectors |
| `server.py::_load_model` Hugging Face branch | readiness worker; transcribe/known-audio probe; Docker candidate execution | Pass the required immutable revision to the Transformers loader; never resolve mutable `main` while producing benchmark or learner evidence | isolated loader-call test plus readiness/attribution suite; no network required for mutation cases |
| ASR candidate registry and W1.5 selection evidence (new) | benchmark operator; ASR image selection; future W1.12 signed release evaluator and W5 runtime comparison | Register exact runnable/research-only artifacts and fail closed on aliases, fixtures, candidate/dataset/evaluator mismatches, missing slices, missing approvals, or unapproved thresholds; retain `blocked-no-eligible-benchmark` while prerequisites are absent | `asr-candidate-evidence.test.mjs` positive structural vector and mutations for every refusal; production Compose must not claim winner status |
| Node/Rust `proxy_ml` model guard | public ML prediction routes and parity harness | Refuse any request-side model selection and validate producer attribution before forwarding it to callers/persistence | Node/Rust parity for absent versus supplied model identity and invalid upstream attribution |
| Flutter/session creation and Node/Rust alignment persistence model inputs | `PracticeScreen`; `ApiClient`; session/alignment parity and DB tests | Remove caller-supplied selection; choose the session identity server-side and reuse it on alignment writes instead of the `model-v0.3` fallback | Flutter request-shape test; Node/Rust parity; server-selected session identity proof |
| `services/ml-inference/server.mjs::transcribeSession` | `/v1/session-transcript` route dispatcher; Rust `finalize_session`; `server.test.mjs`; `session-transcript.test.mjs`; `scripts/measure-long-audio.mjs` | W1.6: validate a complete single-rate PCM timeline, call ASR/recognized-transcript force alignment in bounded context windows, core-select real tokens, add absolute offsets, and refuse partial evidence | window count/duration, overlap ownership, repeated-token preservation, absolute monotonic offsets, missing/mixed-rate/malformed/unavailable refusal, live declared-audio proof |
| ASR `/v1/force-align` response | Rust/Node ASR public proxies; Web transitional force-align flow; new ML recognized-transcript helper | W1.6 uses it only when transcription has text but no usable timestamp words; require exact token correspondence and forced-aligner attribution | exact-count/text/span tests; unavailable 501 and malformed-result refusal; never send canonical passage |
| `services/ml-inference/server.mjs::predictAlignment` | exported handler; route dispatcher; Rust `finalize_session`; future Node finalize; ML, contract, and API-parity tests | W1.7: map trusted measured recognized tokens, return source spans, and explicitly refuse non-evidence input; no full-canonical force alignment | `real-audio-finalize.test.mjs`; omitted words get no fabricated span; persistence constraint; provenance round trip |
| `services/ml-inference/alignment.js::alignWords` | `server.mjs::predictAlignment`; `alignment.test.mjs`; `golden-regression.test.mjs`; `marks-parity.test.mjs` | W1.7: remain Quran-constrained while carrying source-token spans; retain string compatibility during cutover; never normalize canonical bytes | canonical-byte, timed token mapping, insertion/deletion/repetition, and span monotonicity tests |
| Rust `finalize_session` alignment replacement transaction | session transcript route; ML alignment route; `persist_alignments`; weekly accuracy/readback; future Node W2.6 finalizer | W1.7: require server-derived measured tokens and producer finalizability; persist matched/misread only; roll back every replacement row when any claimed row is invalid | live Rust rollback integration; real-audio finalize E2E; 98-test parity coverage ledger |
| Rust/Node public ML alignment proxies | Flutter/Web/API callers; ASR/ML upstream; API parity suite | Reject client-supplied `recognizedTokens` before upstream forwarding so public callers cannot mint measured evidence | 14-case ML/ASR proxy parity suite and hostile request assertion |
| `WordAlignment` / `PredictedWordAlignment` span contract | ML producer; Rust persistence; Node proxy; Flutter model generation boundary; OpenAPI fixtures | Require explicit nullable integer spans; require finalizable/reason at the prediction envelope; no omitted field may be interpreted as evidence | OpenAPI completeness, strict fixture mutation, producer-response validation, TypeScript typecheck |
| `model-attribution.mjs::{validateModelAttribution,quranAlignmentAttribution}` | ML alignment/Tajweed producers; bounded session transcription; Node ML proxy; contract parity | W1.8: deterministically merge identical window records, preserve ASR plus optional forced-aligner, and refuse component conflict before Quran composition | identical multi-window, mixed ASR/forced, conflict, missing, malformed, and ordering tests |
| `services/ml-inference/server.mjs::transcribeSession` success envelope | Rust `finalize_session`; session transcript tests; real-audio E2E | Return server-derived transcript source plus full producer attribution/model label; refuse a successful measured transcript with missing/conflicting attribution | bounded multi-window and force-align tests; private-finalize E2E |
| `model_versions` alignment selection | Rust/Node session creation; session audit; recitation session FK; word/run persistence | Add one explicit `runtime_selected` deterministic Quran-aligner row; select exactly that row; never rewrite legacy session identity | migration convergence; zero/multiple-selected refusal; producer/session mismatch rollback |
| `alignment_runs` plus `word_alignments.alignment_run_id` | finalizer; staff alignment read; privacy export/delete; RLS; schema-equivalence fixtures | Store one tenant-bound run document and link only its word rows; require run link for new server-derived writes; preserve legacy rows as provenance-null | migration/RLS/FK mutations; atomic roundtrip; privacy isolation |
| Rust `list_session_alignments` / Node `listSessionAlignments` | staff Command console; API parity; OpenAPI `WordAlignment[]`; future Flutter teacher review | Return exact transcript source, compatibility model, component attribution, dataset, evidence ids, and audit id without defaulting missing legacy provenance | W1.8 E2E DB readback, contract shape, byte parity, cross-tenant/role matrix |
| `services/ml-inference/server.mjs::predictTajweed` | exported handler; route dispatcher; Rust/Node ML proxies; web and Flutter practice clients; ML smoke/contract tests | Return disjoint `annotations[]` and `findings[]`; canonical and declared-fixture rules are annotations, while findings remain empty until an acoustic producer exists | `tajweed-analysis-basis.test.mjs`; no-invented-confidence; strict OpenAPI fixtures; smoke |
| `services/ml-inference/tajweed.js::{analyzeWord,analyzeAyah}` | `predictTajweed`; rule/unit and golden regressions; former Rust/Node finding-persistence shape test | Emit `analysisBasis=text-rule`, `instructional=true`, sources, and rule metadata with no confidence/severity/review state | all-rule structural test; no invented confidence; canonical-byte regressions |
| Rust `proxy_ml::{persist_tajweed_findings,redact_withheld_findings}` and Node `proxyMl::{persistTajweedFindings,redactWithheldFindings}` | public Tajweed prediction; session alignment ownership; audit/persistence; learner response | Validate annotation/finding separation before use; never persist annotations; allow only explicit acoustic findings into session performance storage | hostile upstream semantic mutations; response parity; effect parity |
| `tajweed_findings.analysis_basis/confidence` and review/read queries | migration 0025; teacher list/review; learner session read; privacy paths; OpenAPI staff/session shapes | Migration 0030 reclassifies `canonical-text` to `text-rule`, nulls its placeholder confidence, enforces basis/confidence consistency, and excludes text rules from performance review and learner feedback without deleting audit history | migration convergence/constraint mutations; review refusal; role/read parity |
| Flutter `TajweedFinding`, `ApiClient.predictTajweed`, `TajweedPanel` | practice finalization and delayed feedback; gate tests | Parse/display acoustic findings only and require `analysisBasis=acoustic`; do not coerce or display instructional annotations as learner error | Dart parse/gate/panel/practice tests |
| `services/agents/lib/gate.mjs::canShowLearnerFacingAiOutput` | Tajweed explainer, mistake summarizer, practice recommender, shared gate corpus | Refuse an explicitly non-acoustic basis while preserving basis-optional generic agent runs; prevent an approved text rule from becoming learner-performance feedback | agents corpus test plus TypeScript/Dart gate parity |
| Python ASR/acoustic modules | ML inference HTTP callers; Compose; smokes; privacy erasure; model/eval scripts | Keep isolated until a candidate wins the real-audio non-inferiority benchmark; replace the current duration/F0/energy signal heuristics as learner-error authority; remove unselected research endpoints | Loaded-model readiness, correct-vs-seeded-error acoustic cases, real evaluator, privacy lifecycle, latency/memory/device/licensing evidence |
| Rust `proxy_ml` / Node `proxyMl` session lookup | public alignment/Tajweed callers; session consent/ownership; ML internal request | Reject caller `learnerId` and acoustic word segments; for Tajweed only, overwrite Quran reference/checksum and inject learner id plus same-session server-derived aligned spans from the restricted database | hostile field-injection parity; client-quran-ref mismatch; non-server-derived/spanless exclusion; tenant/owner matrix |
| `services/ml-inference/server.mjs::{predictTajweed,transcribeSession}` plus audio loader extraction | stored PCM chunk metadata/bytes; Rust/Node proxy; ASR acoustic worker; privacy TTL | Reuse one complete validated PCM timeline, cut bounded context windows from server-derived word spans, and return internal observations separately from learner findings | missing/gapped/mixed-rate/expired audio refusal; boundary/overlap ownership; no raw audio logging; privacy deletion |
| Pinned Muaalem v3.2 shadow adapter | existing Python inference worker; model attribution/readiness; QPS reference bundle; offline evaluator | Pin Hub revision and safetensors digest; run 16 kHz bounded reference-aware phoneme/sifat inference; expose raw observations only, withhold corrupted upstream sifat scores, and keep uncalibrated output out of `findings[]` | digest/load/readiness; byte-reproducible correct-shape and seeded-mutation integration vectors; malformed/short/mismatched reference refusal; latency/memory |
| Versioned QPS reference derivative | canonical word ids/checksums; Muaalem reference tokenizer; error-to-word projection | Generate append-only derived QPS/mappings without normalization or canonical writes; bind upstream code/config and canonical token hashes; runtime reads only the reviewed derivative | full-corpus byte-invariance, checksum, word-boundary/context mapping, NFC vectors, generator determinism |
| `services/asr-inference` heuristic endpoint and `services/tajweed-neural` | no production callers; old docs/tests only | Remove learner authority immediately; retire the disconnected endpoint/service after the selected adapter has equivalent bounded diagnostic proof, with no compatibility route because there are no callers | zero-caller inventory; retired-component test; architecture/release-doc consistency; canonical gate |
| release model/eval manifests | release gate, smoke, governance UI, persistence | Bind artifact digest, implementation, dataset, calibration, approval scope, and signed candidate evidence | `model-evidence.test.mjs`; fixtures are explicitly ineligible for release |

Model attribution currently disagrees (`ml-aligner-v0.2` in inference versus `model-v0.3` in Flutter/persistence), and the Tajweed persistence path may select a sole row by kind. W1 removes both fallbacks: the server-selected ASR, forced-aligner, Quran aligner, acoustic scorer, and calibrator identities/digests must round-trip exactly.

Hard invariants for every caller: canonical text is immutable and never normalized; Arabic regex classes use `\u` escapes; learner feedback remains source/review/confidence/evidence gated; fixtures never impersonate model evidence.

### W1.10 exact caller map

| Planned symbol/file | Direct callers/consumers found | Regression obligation |
|---|---|---|
| `services/asr-inference/server.py::{TajweedAnalysisRequest,TajweedAnalysisResponse,analyze_tajweed,_analyze_tajweed_words_sync}` | no production caller; local attribution/regex tests and historical docs only | Replace rather than preserve the unsafe contract; zero-caller and retired-implementation assertions |
| `services/asr-inference/model_attribution.py::build_acoustic_attribution` | Python route and `test_model_attribution.py` | Require exact model/QPS/profile identities and digest; keep calibrator unavailable in W1.10 |
| new `services/asr-inference/acoustic_tajweed.py` worker/reference/window functions | private Python route; exact-model release harness | Unit boundary/refusal tests plus exact-artifact correct/altered-audio candidate proof |
| `services/ml-inference/server.mjs::transcribeSession` audio assembly | `/v1/session-transcript`; Rust finalizer; transcript unit/fault/long-audio tests | Extract without changing transcript behavior; run every existing transcript/finalize proof |
| `services/ml-inference/server.mjs::predictTajweed` | route dispatcher/export; Rust/Node ML proxies; web/Flutter; ML/contract/smoke tests | Invoke shadow observation path, audit status, preserve annotations, return zero uncalibrated findings |
| Rust `handlers/ml_proxy.rs::proxy_ml` | `proxy_predict_alignment`, `proxy_predict_tajweed`; Rust router; API parity | Inject only stored Tajweed context; preserve alignment behavior and learner redaction/persistence |
| Node `routes/ml-proxy.mjs::proxyMl` | exported `predictAlignment` and `predictTajweed`; portable route registry; API parity | Byte/effect parity with Rust for field refusal, stored context, tenant ownership, and response stripping |
| `services/tajweed-neural/**` | no production import/caller/Compose service; README and living-doc references | Remove only after selected-adapter proof; retired-component and living-doc tests prevent resurrection |
| `tests/security/arabic-regex-escapes.test.mjs::trackedSources` | repo-wide Arabic-regex guard callback | Ignore index entries deleted from the working tree so an approved component retirement is scanned as absence, while every remaining tracked source is still checked |
| ASR Docker/lock and acoustic candidate manifest | Compose ASR service; readiness/image tests; release/SBOM/licence checks | Default-image compatibility, exact candidate-image digest/readiness, clean dependency audit |

## 5. Node HTTP convergence

### W2.1 accepted-decision guard

| Decision boundary | Current consumers | W2.1 change | Proof before package creation |
|---|---|---|---|
| Node process/package topology | approved final tree; future `server/src/{api,realtime,workers}`; Compose/release images | Accept one Node package with independently drainable API, realtime, and worker entrypoints; CPU inference never shares the API event loop | `tests/contract/node-backend-decisions.test.mjs` checks ADR-0050 and living architecture wording |
| Node runtime dependency ownership | root `package.json` devDependencies; `services/node-api`; future `server/package.json` | Runtime imports belong in `server` production dependencies and its lock graph; root remains orchestration only; native platform APIs are preferred where sufficient | decision guard now; W2.2 workspace/install/build and standalone lifecycle proof later |
| Retained-audio storage | filesystem ML adapter, privacy/export/delete, gateway index, teacher playback | Accept private S3-compatible object storage for production and filesystem only for test/dev; server-derived keys and DB index/outbox remain authoritative | decision guard now; W2.14 lifecycle/tenant/fault proofs before activation |
| Deadlines and rate limits | Node proxy/ML/ASR/privacy/audio fetches; future API/realtime/worker callers | Accept one monotonic deadline budget propagated with `AbortSignal`; no completed claim after cancellation. Use bounded per-process request buckets plus durable Postgres uniqueness/attempt state for credential/replay boundaries; trust only configured proxy hops; add no Redis/NATS | decision guard now; W2.10/W2.12 middleware and hung-dependency tests later |
| Production identity | ADR-0038; pilot invitations/cookies; Flutter future secure enrollment | Reaffirm owner-gated login-off posture, single-use device exchange, server-derived tenant/role, hash-only credentials, rotation/revocation/expiry, and provisioned staff | ADR cross-reference guard now; W2.16 enrollment tests before route activation |

### W2.2 server package boundary

| Symbol or boundary | Direct callers/consumers found | W2.2 change | Regression obligation |
|---|---|---|---|
| `services/node-api/server.mjs::buildServer` | guarded direct startup in the same file; `tests/node-api/{shell,no-secret-logging}.test.mjs`; route-table and API-parity harnesses read or spawn the legacy path | Add `server/src/app.mjs::createApplication` as a side-effect-free composition adapter that delegates to the unchanged legacy builder; move no route behavior | Existing shell/security/parity suites plus `standalone-lifecycle.test.mjs` health injection and close |
| root `package.json` runtime-shaped dev dependencies | legacy Node API/service tests, migration/operator scripts, root contract tests | Declare the production runtime dependency graph in `server/package.json`; retain root development copies only while legacy files and root tests resolve them, then remove them during W2.4 relocation | Frozen workspace install; manifest ownership assertions; server typecheck/build |
| `pnpm-workspace.yaml` | pnpm install/filter/lockfile; CI dependency cache | Add only `server` as the backend workspace member; do not absorb Python/Rust/Flutter projects | Frozen install and `pnpm --filter @quran-ai/server ...` proofs |
| root `package.json::{typecheck,build}` and `scripts/verify.sh` equivalents | local developers and canonical CI gate | Include the server workspace type/build checks and invoke the standalone lifecycle test exactly once | invocation guard; focused lifecycle test; canonical gate |
| `server/scripts/{migrate,provision-role,repair-audio-index}.mjs` | root operator scripts; `pg` | Remain in place and behaviorally unchanged; the new package owns their production `pg` dependency | Existing migration/restricted-role/audio repair tests |

W2.2 is a package/composition seam only. The Rust API remains the traffic target, the legacy Node
modules remain the behavior source, and no standalone-production or cutover claim is made; W2.3 and
W2.4 prove those independently.

### W2.3 production image and internal shadow service

| Symbol or boundary | Direct callers/consumers found | W2.3 change | Regression obligation |
|---|---|---|---|
| new `server/Dockerfile` | Docker Compose build; Docker CI; immutable release-image builder | Multi-stage deploy from the frozen server workspace lock graph; pin Node 22.13.1 by multi-arch digest; ship only production dependencies, `server` runtime files, the legacy Node modules still delegated to by W2.2, and the exact ML attribution/alignment/provenance files imported by that boundary; run as the non-root `node` user | static production-image test; real Docker build; clean filesystem/dependency/non-root smoke |
| new `server/src/container-healthcheck.mjs` | Dockerfile `HEALTHCHECK`; Compose `node-api.healthcheck` | Native-fetch readiness probe with bounded timeout and no curl/apt runtime addition; expose a pure callable seam for hermetic success/refusal tests | healthcheck unit vectors and real container health transition |
| `docker-compose.yml::node-api` (new) | default internal stack; Docker CI; release image builder | Add an internal-only shadow on port 8082 with only `/health` and `/ready` local, restricted database credentials, Rust `platform-api` as compatibility upstream, and no Web/gateway routing dependency | Compose topology assertions; `docker compose config`; Rust remains the Web/gateway target |
| `scripts/release-images.mjs::SERVICES` | image build/tag/digest/retention loops; release-image workflow | Add `node-api` so the shadow image has a candidate-bound digest and rollback tag before it can receive traffic | existing retention tests plus exact six-service topology assertion |
| release/smoke `deployableServices` constants | build evidence, release manifest verification, smoke evidence and their tests | Require the `node-api` digest anywhere a complete deployable candidate is claimed | release-manifest/build/smoke evidence suites |
| `.github/workflows/docker-build.yml` | Dockerfile/Compose PR gate | Trigger on server/legacy Node/lock changes; build the image, assert non-root, verify a clean runtime, and run its native healthcheck without Rust traffic | workflow/static guard now; required remote Docker CI before ledger completion |
| root licence and SBOM gates | `scripts/check-licenses.mjs`; CI root CycloneDX generation | Server is already a workspace member, so its production dependency graph is included without a second allowlist; pin this behavior in the image/topology test | licence guard; SBOM workflow assertion; canonical gate |

W2.3 does not switch callers. `web` and `realtime-gateway` continue to depend on and address
`platform-api`; the new `node-api` service has no published host port and observes readiness only.

### W2.4 incremental module relocation — slice 1

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/insecure.mjs::{insecureSecretProblems,relaxed,isRelaxed}` | `services/node-api/server.mjs` boot refusal and metrics policy; `tests/node-api/boot-guard.test.mjs` direct contract | Move this dependency-free security leaf to `server/src/lib/insecure.mjs`; update both known importers; delete the old path rather than keeping a compatibility duplicate | module-relocation guard; full boot-guard and shell/image tests; canonical gate |
| `server/Dockerfile` production file set | deployed `server/src`; copied legacy `services/node-api` | Receive the moved leaf automatically through the server package deploy while the legacy entrypoint imports across the temporary boundary | real image build/health remains green in W2.4 evidence |
| root runtime dependency copies | legacy service paths and root tests | No dependency removal in this leaf slice; remove a root copy only when its last legacy/root caller moves | frozen install plus package build |

The proxy rollback entrypoint remains `services/node-api/server.mjs`; only one leaf module changes
ownership in this slice. The next slice is selected only after this move receives canonical proof.

### W2.4 incremental module relocation — slice 2

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/metrics.mjs::{LATENCY_BUCKETS_MS,escape,createMetrics,metricsAccessAllowed}` | `services/node-api/server.mjs` creates and records the process metrics; `services/node-api/routes/infra.mjs` gates and renders `/metrics`; `tests/node-api/metrics-render.test.mjs` imports the complete public surface | Move this dependency-free observability leaf to `server/src/lib/metrics.mjs`; update all three importers; delete the old path without changing bucket, escaping, render, or access decisions | module-relocation guard with exact export inventory; full metrics-render, shell, route-table, and image tests; canonical gate |
| `server/Dockerfile` production file set | deployed `server/src`; copied legacy route and entrypoint files | Receive the metrics leaf through the server deploy while the transitional route/entrypoint imports cross into the new owner | real image rebuild, native health transition, and in-container module import |
| `/metrics` rollback behavior | Rust compatibility upstream; `NODE_API_PORTED` allowlist | No route cutover: the route is local only when explicitly ported, otherwise the existing proxy path remains available | shell port allowlist plus direct/through-Node parity |

Slice 2 preserves the existing Prometheus bytes and fail-closed token policy. It does not change the
traffic target or authorize removal of the legacy proxy shell.

### W2.4 incremental module relocation — slice 3

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/json.mjs::{f32,f64,formatF32,formatF64,sortKeysDeep,stringifyRust}` | `services/node-api/server.mjs` reply serializer; six route modules (`agent-write`, `progress`, `reports`, `review`, `session-writes`, `sessions`); direct `rust-json` tests; reports/session parity helpers | Move the dependency-free Rust-wire serialization leaf to `server/src/lib/json.mjs`; update all eleven import statements; delete the old path and preserve its six exports | exact-export/caller relocation guard; complete Rust JSON vectors; shell and affected report/session parity tests; canonical gate |
| Rust-float sentinel and recursive key ordering | every local Node response containing f32/f64 wrappers or untyped `jsonb`; API golden/parity comparisons | Ownership-only move: retain random per-call nonce, non-finite refusal, f32 narrowing, f64 decimal shape, deep BTreeMap ordering, and hostile-string safety | `rust-json.test.mjs`; reports/session direct and through-Node parity; hostile payload vectors |
| `server/Dockerfile` production file set | deployed `server/src`; copied legacy routes and entrypoint | Receive the JSON leaf through the server deploy while every transitional importer resolves across the package boundary | source-built image health plus in-container serialization/parse proof |

Slice 3 changes no response schema or serializer policy. Any byte difference is a regression, not a
cleanup opportunity.

### W2.4 incremental module relocation — slice 4

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/learner-feedback-gate.mjs::clearsLearnerFeedbackGate` | `routes/review.mjs` learner read redaction; `routes/ml-proxy.mjs` inference response redaction; `tests/contract/tajweed-gate-parity.test.mjs` imports the function and reads its source twice for cross-runtime guard checks | Move the single-export, dependency-free authority gate to `server/src/lib/learner-feedback-gate.mjs`; update both runtime imports and all three test path references; delete the old owner | exact-export/caller relocation guard; shared expanded gate corpus; source-policy/digest/confidence mutation assertions; affected review/ML parity; canonical gate |
| Learner-facing acoustic evidence threshold | Node, Web, Rust, and Flutter shared corpus; review/persistence boundaries | Ownership-only move: preserve inclusive 0.82 floor, acoustic-only basis, reviewed status, complete sources/spans/ids/digests, available audio, calibrated status, and release-trusted evidence | `tajweed-gate-parity.test.mjs`; `learner-feedback-gate.test.mjs`; `tajweed-analysis-basis.test.mjs`; direct and through-Node review/ML parity |
| `server/Dockerfile` production file set | deployed server source plus copied legacy routes | Receive the learner gate through server deploy while transitional route importers resolve the new owner | source-built non-root image; in-container positive/negative gate vectors; health transition |

Slice 4 is an ownership move only. It must not make an unreviewed, unsourced, uncalibrated, or
non-acoustic result visible to a learner.

### W2.4 incremental module relocation — slice 5

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/proxy.mjs::proxy` | `services/node-api/server.mjs` catch-all forwarding; eleven route modules (`agent-write`, `auth`, `ml-proxy`, `pilot`, `privacy`, `progress`, `recitation`, `reports`, `review`, `session-writes`, `sessions`) that delegate pilot-cookie paths or rollback handling | Move the single-export, dependency-free forwarding leaf to `server/src/lib/proxy.mjs`; update all twelve runtime imports; delete the old owner | exact-export/caller relocation guard; shell proxy vectors; affected pilot-cookie delegation; direct/through-Node parity; canonical gate |
| `proxy` byte, header, cookie, redirect, and status preservation | every transitional Node route that forwards to the Rust oracle or uses delegated pilot identity behavior | Ownership-only move: preserve raw request/response bytes, repeated `set-cookie`, manual redirects, absent content type, upstream status, and hop-by-hop filtering | `shell.test.mjs` response/request byte vectors, multiple-cookie and no-content-type cases, status/empty-body/CORS/preflight vectors |
| `server/Dockerfile` production file set | deployed `server/src`; copied transitional entrypoint and routes | Receive the proxy leaf through the server deploy while every transitional importer resolves across the package boundary | source-built non-root image; in-container module import and health transition |

Slice 5 changes no forwarding semantics. Header normalization, body parsing, redirect following, or
inventing a content type would be a wire-compatibility regression.

### W2.4 incremental module relocation — slice 6

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/db.mjs::createDb` | `services/node-api/server.mjs` creates the shared pool; `tests/node-api/db-tenant.test.mjs` imports the primitive directly; `specs/cutover/boundary.md` cites the implementation as cutover assurance | Move the single-export database leaf to `server/src/lib/db.mjs`; update both direct imports and the assurance citation; delete the old owner | exact-export/caller/reference relocation guard; missing-connection refusal; boundary reference integrity; server lifecycle/build; canonical gate |
| returned `{sql,withTenant,currentTenantSetting,end}` boundary | `buildServer` supplies it as `ctx.db`; 29 `withTenant` call sites across auth, pilot, review, inference, recitation, sessions, reports, progress, privacy, writes, and agent routes; `authz.mjs` also rolls pilot-session expiry through it | Ownership-only move: retain one reserved transaction, transaction-local tenant GUC, bounded statements, callback result/rollback behavior, pooled leak probe, and bounded close | live restricted-role RLS tests for success, JS failure, database failure, interleaving, invalid tenant, and stale-valid-context hazard; direct/through-Node parity |
| `server/package.json` and production image | `postgres` is already a declared server production dependency; deployed `server/src` receives the module | No dependency addition; ensure the deployed server package resolves `postgres` without relying on the legacy root | package build; source-built non-root image; in-container guarded constructor/import and health transition |

Slice 6 changes no SQL, tenant policy, pool setting, timeout, or query caller. A missing, stale, or
connection-scoped tenant context is a cross-tenant data risk and must remain a hard regression.

### W2.4 incremental module relocation — slice 7

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/ticket.mjs::{TICKET_VERSION,ticketPayload,signTicketPayload,issueRealtimeTicket,verifyRealtimeTicket,newNonce}` | `routes/recitation.mjs`; `tests/node-api/ticket-vectors.test.mjs`; three gateway process/E2E suites; teacher-audio-index E2E; gateway smoke and reconnect-chaos scripts | Move the native-crypto ticket authority leaf to `server/src/lib/ticket.mjs`; update all eight code imports; delete the old owner | exact-export/all-caller relocation guard; shared Node/Rust vectors; gateway accept/reject and retention/index fault suites; canonical gate |
| `rt_v2` dot-delimited HMAC-SHA256 wire contract | unchanged Rust `shared-ticket` validator and realtime gateway; Flutter/Web clients consume API-issued opaque tickets | Ownership-only move: preserve field order, boolean rendering, retention, u64-compatible expiry, 32-lowercase-hex nonce, lowercase signature, constant-time verification, separator/empty/type refusals | ticket vector corpus; hostile inputs; tamper/version/retention/wrong-secret refusals; Rust shared-ticket tests; live WebSocket suites |
| assurance references to the ticket implementation | `specs/gateway-ws-sweep/{research,impact-map}.md` and `specs/node-backend-port/impact-map.md` | Retarget current implementation citations without rewriting the recorded test/evidence claims | module relocation reference guard plus repository stale-path scan |
| `server/Dockerfile` production file set | deployed `server/src`; transitional recitation route imports the moved authority | Receive the ticket leaf through the server deploy with no added dependency beyond native `node:crypto` | source-built non-root image; in-container deterministic sign/verify/tamper probe; health transition |

Slice 7 changes no ticket bytes, consent meaning, expiry, replay behavior, or gateway protocol. Any
wire difference would be a cross-service outage and must fail before route migration proceeds.

### W2.4 incremental module relocation — slice 8

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/lib/authz.mjs` exported authorization surface | `services/node-api/server.mjs`; twelve route modules (`agent-write`, `auth`, `ml-proxy`, `pilot`, `privacy`, `progress`, `quran`, `recitation`, `reports`, `review`, `session-writes`, `sessions`); direct `authz` oracle | Move the `jose`/native-crypto authorization authority to `server/src/lib/authz.mjs`; update all fourteen code imports; delete the old owner | exact-export/all-caller relocation guard; complete authz oracle; authz matrix; hostile-input and direct/through-Node parity; canonical gate |
| `resolveActor`, pilot-session resolution, and credential precedence | every protected local Node route; shared DB transaction primitive; delegated unported cookie requests | Ownership-only move: preserve Bearer → pilot cookie → development-header precedence, HS256 allowlist, fail-closed claims, cookie parsing, Origin/CSRF checks, expiry/idle roll, and generic refusals | bearer/`alg:none`/header/cookie tests; live pilot auth/route parity; cross-tenant and role matrix; no-secret logging |
| `requireSelfOrAny`, `requireAnyRole`, and error classes/factories | ownership and role gates across protected routes; server error serializer | Preserve degenerate-input refusal, exact 401/403/404/422 messages/content types, and `ApiError` identity across the composition boundary | direct ownership matrix; response fixtures; NUL/error shaping; all route parity |
| assurance references to the authorization implementation | two citations in `specs/cutover/boundary.md`; `specs/node-backend-port/impact-map.md` | Retarget implementation citations and pin them in the relocation guard | boundary reference integrity and stale-path scan |
| `server/package.json` and production image | `jose` is already a declared server production dependency; deployed `server/src` receives the module | No dependency addition; transitional entrypoint/routes resolve the canonical owner | package build; source-built non-root image; in-container error/ownership/JWT refusal probe; health transition |

Slice 8 changes no role, credential source, precedence, cookie, CSRF, tenant, or error policy. This is
the highest-impact library relocation; any caller or class-identity split is a hard regression.

### W2.4 incremental route relocation — slice 9

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/routes/index.mjs::{ROUTES,fastifyPath}` and thirteen domain route modules | legacy `server.mjs`; direct route-table/readiness/authz/gate tests; live parity harness and authz source matrix | Move the complete mutually-coupled route layer to `server/src/routes`; update entrypoint and executable consumers; delete the old route tree | route-owner/file-set guard; exact 42-operation table; handler/export loading; focused direct tests; canonical direct/through parity |
| route-to-library imports | all protected, DB, JSON, metrics, proxy, feedback-gate, and ticket handlers | Collapse temporary cross-package `../../../server/src/lib` paths to canonical sibling `../lib` paths; preserve internal route imports | stale cross-boundary import scan; package build; production image |
| ML attribution bridge | `ml-proxy.mjs` imports the retained inference validator | Retarget from the old service-relative path to `../../../services/ml-inference/model-attribution.mjs` after the move | ML proxy contract/parity and deployed image import |
| static route consumers and citations | `routes-table`, `readiness-fault`, `authz`, learner-gate, acoustic-boundary, ML-findings shape, no-secret-logging source scan, authz-matrix; verify/comment/spec citations | Retarget executable reads/imports and current implementation citations; keep route-gate counts mechanically derived and source scans non-vacuous | focused tests plus canonical invocation/reference guards |

Slice 9 is a single ownership move because the route index eagerly imports every domain module.
Splitting it would create a second composition tree. No handler logic, route key, body limit, or
middleware order changes.

### W2.4 entrypoint consolidation — slice 10

| Symbol or boundary | Direct callers/consumers found | Slice change | Regression obligation |
|---|---|---|---|
| `services/node-api/server.mjs::buildServer` | `server/src/app.mjs`; shell and no-secret-log tests; its own startup path | Make `server/src/app.mjs::createApplication` the sole side-effect-free composition owner; remove the wrapper/delegation and the legacy file | exact package exports; import-without-listen; health construction/close; shell/error/NUL tests; canonical parity |
| legacy process entrypoint and `PORTABLE` literal | Docker `CMD`; parity harness; boot guard; route-table/authz matrix source readers; `cutover-readiness.mjs`; `verify.sh` through-Node route derivation | Add one package-owned `server/src/main.mjs` for environment validation, portable allowlist validation, bind/listen, and process exit behavior | missing/weak configuration refusals; full portable-set parse; live spawn/health; direct and through-Node parity |
| `services/node-api` deployment copy | `server/Dockerfile` copies the transitional tree and starts its entrypoint | Remove the legacy copy; deploy and start only `server/src` plus the narrow retained ML attribution bridge | source-built non-root image; no legacy runtime files; healthy container; package dependency isolation |
| static implementation consumers | NUL-byte contract, route table, authz matrix, readiness and relocation guards, verify/cutover scripts | Retarget all executable reads/imports/spawns to `server/src/{app,main}.mjs`; pin absence of the old owner | red-first ownership test, non-vacuous scans, stale executable-path guard, `git diff --check` |

Slice 10 changes ownership and process topology only. `createApplication` retains the exact Fastify
composition and `main.mjs` retains the exact boot policy; no middleware, route, proxy, error, secret,
or traffic behavior changes.

| Source symbol/boundary | Current callers | Node target/affected callers | Required tests |
|---|---|---|---|
| `services/node-api/server.mjs::buildServer` | direct startup path; shell/boot/readiness tests | Testable lifecycle in `server/src/app.mjs`; API entrypoint owns listen/drain | Standalone lifecycle, clean production image, health/readiness, graceful shutdown |
| Rust `index_audio_chunk` | Rust gateway `handle_audio_socket`; audio playback/index chain | Node recitation domain with full ticket/session/retention validation | True local Node audio-index parity; wrong session/expired/idempotent/span/playback cases |
| Rust `finalize_session` | Flutter `ApiClient.finalizeSession`; `PracticeScreen` finding load; DB/alignment/Tajweed paths | Node finalize job/handler sharing one transactional alignment persistence function | Consent/no-transcript/lost-chunk/server-derived/timeout/idempotence tests |
| Rust `list_session_tajweed_findings` | Flutter immediate finding retrieval | Node review handler preserving learner redaction | Accepted/withheld/staff/cross-tenant tests |
| learner-owned session history (new) | Flutter feedback inbox; cross-device retrieval | New own-only listing; do not weaken staff `GET /v1/recitation-sessions` | Own-only, cross-tenant 404, pagination, delayed-review E2E |
| device enrollment (new) | Flutter `AuthController`, `TokenStore`, actor reconstruction | One-time invitation exchange with server-derived tenant/role, rotation/revocation | Enrollment, reuse, expiry, role forgery, logout/401, secure-device evidence |
| Rust rate limit and maintenance guards | every HTTP route except approved probes/preflight | Node middleware with trusted-proxy semantics and documented order | `middleware-order`, burst/refill/preflight/proxy-bypass, maintenance probe tests |
| Rust restricted-role boot check | API startup | `assertRestrictedDbRole` before Node listen | superuser refusal, `BYPASSRLS` refusal, restricted-role success |
| Node `proxy`, ML `forward`, privacy `eraseMlAudio`, review audio read | route proxying, ML/ASR, privacy jobs, teacher playback | One `fetchWithDeadline`/abort policy with operation budgets | Hung Rust/ASR/object-store/privacy/audio-read tests |
| `scripts/release-images.mjs::SERVICES` | `main` validation/build loop | Add Node while shadowing; remove Rust entries only after observation windows | release image/manifest/SBOM/non-root/clean-image tests |

Deployment consumers that move during HTTP cutover include `docker-compose.yml`, `.github/workflows/{ci,docker-build}.yml`, root package scripts, `scripts/verify.sh`, release/smoke scripts, reverse proxy configuration, architecture/testing/operations docs, and rollback manifests.

## 6. Realtime convergence

| Rust gateway boundary | Known callers/consumers | Node replacement responsibility | Required proof |
|---|---|---|---|
| `GatewayServerConfig`, `RealtimeGateway` | gateway main/router/tests | Separate realtime process from the same Node package | clean boot, readiness, drain, fault isolation |
| `start_session`, `send_chunk`, `end_session`, `resume_sequence`, `record_sequence` | `audio_ws`/`handle_audio_socket`; client protocol | Preserve ordered sequence and reconnect semantics | monotonic reconnect, duplicate/reorder, bounded session tests |
| `validate_origin`, `check_ticket`, `gateway_router_with_rate_limit` | WebSocket upgrade path | Preserve browser Origin policy and explicit native no-Origin policy; verify all ticket claims | hostile-input, replay-across-instances, rate/burst tests |
| `audio_ws`, `handle_audio_socket` | Web `startGatewayAudioUpload`; Flutter `StreamingRecorder`; audio store/index API | Bounded queues, store/index acknowledgement, loss/orphan telemetry | backpressure, oversized/empty frame, index failure, retention E2E |
| shared `rt_v2` ticket and `audio.ack` fixtures | `fetchRealtimeTicket`, URL builders, Web/Flutter clients, Rust `shared-ticket` | Keep wire shape language-neutral through cutover | ticket vectors and client compatibility tests |
| Redis replay behavior in current gateway | ticket single-use path | Proposed Postgres nonce-hash unique record/TTL; raw tickets never stored | cross-instance concurrency and failure-closed load proof before Redis removal |

Known Web client chain: `fetchRealtimeTicket` and realtime URL builders feed `startGatewayAudioUpload`, which is invoked by `LiveAlignmentCard.handleCaptureToggle` through `PlatformCommand`. Flutter currently constructs `StreamingRecorder` from one ticket; it must accept a fresh-ticket provider for safe reconnect.

## 7. Flutter product impact

| Product track | Flutter symbols/files | Existing references/callers | Proof and release blockers |
|---|---|---|---|
| Localization | `main.dart::QrAiApp`; hard-coded strings under `src/{feedback,practice,privacy,reader,review,shell}`; new ARB/l10n manifest | Web locale capability functions and i18n review tests are temporary governance oracles | Locale key/direction/fallback tests; human review. Current Sorani translation data covers only Surahs 1, 2, 78–114, so full-corpus wording is blocked |
| Reader → practice | `main.dart::{HomeShell,ReadTab,SurahScreen}`; `PracticeScreen`; shared `QuranRef` selection | `QrAiApp → HomeShell → ReadTab/PracticeScreen`; `SurahScreen → MushafPage` | Reader-to-practice journey; range/CTA; canonical-byte test |
| Reference audio/guided loop | `PracticeScreen`; `MushafPage`; `AyahView`; new audio/timing controller; `pubspec.yaml` | Alafasy timing package; frozen Web `practiceSteps`, `AudioCoach`, timing helpers | Audio dependency ADR; timing parity; interruptions; physical iOS/Android playback |
| Progress | `ApiClient`, models, `PracticeScreen`, `ProgressTab` | Current Flutter reads only; backend progress/weekly routes; Web save flow as temporary oracle | Exactly-once write only after server-finalized evidence; server-owned SM2/clamp; refreshed UI |
| Feedback inbox | new `LearnerSessionSummary`, own-session API, inbox/history | Existing immediate `_loadFindings`; staff session list must stay staff-only | pending/approved/redacted/refresh/cross-device E2E |
| Enrollment | `ApiClient.login` replacement; new `AuthController`; `TokenStore`; `Actor`/`HomeShell` rebuild | Debug provisioning today; browser cookie bootstrap is not reusable by native | Owner-approved production identity ADR; Keychain/Keystore; expiry/revocation/401 tests; no build token |
| Reconnect/fallback | `StreamingRecorder`; new fresh-ticket provider and bounded PCM buffer; batch API methods | Current recorder has one ticket; Web live/batch flows are temporary protocol references | Fresh ticket, oldest-first buffer, drop accounting, consent, physical network-loss proof |
| Teacher review/audio | split/extend `TajweedFinding`; `FindingAudio`; `ApiClient`; `ReviewQueueScreen` | Correct route is finding audio, not stale Web session-audio route | Seek/span/no-audio/provenance/edit tests and physical playback |
| Scholar approval | scholar navigation; models/API; queue/detail | Rust review handlers/types; current generic free-text contract | First add immutable target hash and pending candidates; migration/RLS/OpenAPI/authz; then source/risk/actor/UI tests |

## 8. Component retirement map

### 8.1 Expo (`apps/mobile`)

Direct set: `apps/mobile/**`, `.github/workflows/mobile.yml`, Expo proof/verify blocks, dependencies/lock entries, and current-state architecture/testing/roadmap references. Serena found only `apps/mobile/index.ts` calling Expo `App`; no workspace consumer imports it.

Deletion gate: signed Flutter Android/iOS distribution, physical microphone round trip, enrollment, reconnect/batch fallback, and equivalent session persistence. This is the first safe client retirement.

### 8.2 React (`apps/web`)

Current dependencies include the workspace/lockfile, root scripts, `apps/web/Dockerfile`, nginx configs, Compose, Docker/release workflow, browser/a11y/i18n/security/smoke scripts, icon/recreate-staging utilities, Web component tests, living docs, and release evidence.

Deletion gate: Flutter has learner, teacher audio/review, scholar/source approval, privacy, enrollment, localization governance, accessibility, Flutter Web delivery, security-header, and release equivalents. Retain a frozen/reduced staff Web until those replacements are proven; then retarget every operational consumer in the same retirement task sequence.

### 8.3 Rust platform API (`services/platform-api`)

Deletion gate: corrected baseline; retained Node HTTP parity/effects/hostile-input tests; all permissive schemas resolved; production middleware; restricted-role boot; load/soak; gateway points to Node and indexes audio; rollback/restore rehearsal; Rust image digest retained through one observation window.

Removal affects Cargo workspace, root API commands/tests, `scripts/verify.sh`, CI Cargo cache/audit, Compose, nginx, Docker/release manifests, A/B oracle tests, monitoring, architecture/testing/operations docs. Do not remove `shared-ticket` here.

### 8.4 Rust realtime gateway and `shared-ticket`

Deletion gate: independent Node realtime parity, hostile-input/fault/load/100-session proof, canary/soak, client compatibility, rollback rehearsal, and durable replay proof. Delete the gateway first, then `shared-ticket`; remove the Cargo toolchain only when no crate remains. Retain ticket/audio wire fixtures permanently.

### 8.5 Experiments and historical structures

- `services/tajweed-neural`: remove unless the real evaluation explicitly selects it.
- `services/agents` and agent routes: remove after the retirement ADR, caller-zero proof, retention decision, and any needed migration of genuinely useful domain code into ordinary jobs.
- Research-only ASR endpoints: remove after W1/W5 selects the production path.
- Historical specs: remove only after `docs/migration-summary.md` records commit ids, retained decisions, and unresolved risks. Git is the archive; no `legacy/` tree.
- Local `backups*`, `.audit`, `out`, caches, virtual environments, and untracked artifacts are excluded from automatic cleanup and require separate explicit approval.

## 9. Test and documentation impact by wave

| Wave | Minimum changed proof surfaces | Living docs/ADRs |
|---|---|---|
| W0 | route parser/inventory, OpenAPI, migration runner/equivalence, audio index E2E | testing, architecture; route-retirement and contract-generation ADRs |
| W1 | Quran provenance/NFC, real-audio finalize, Tajweed basis/gate, evaluator/model evidence | Quran/model architecture, data/model cards, evaluation runbook |
| W2 | Node standalone/image, route/effect parity, RLS/role, middleware, timeouts/drain, storage/privacy, enrollment | backend/storage/identity/dependency ADRs; architecture/operations/testing |
| W3 | ticket vectors, replay, hostile WS, backpressure, reconnect, index/retention faults, load | realtime/replay ADR; operations/monitoring |
| W4 | generated client, localization, guided journey, progress, inbox, teacher, scholar, device failures and signed artifacts | product/localization/playback ADRs; privacy/accessibility release matrix |
| W5 | loaded-model readiness, real benchmark, candidate-bound signed evidence | inference exception/selection ADR; model/data cards |
| W6 | final topology, immutable manifest/SBOM, deep readiness, canary/rollback/restore/signoffs | architecture, decisions, testing, operations, migration summary |
| W7 | retired-component/lean-tree/living-doc guards plus final clean-clone release gate | final five living docs and migration summary |

## 10. Rollback and destructive-change boundaries

- All strangler migrations are additive and readable by both active binaries. Database rollback is forward-fix only.
- No table/column drop ships with removal of its last reader/writer. Deprecate, observe, back up as approved, and drop in a later migration.
- HTTP traffic can return to the retained Rust API independently of realtime traffic.
- Realtime traffic can return to the retained Rust gateway while the Node API remains active.
- React and previous Flutter candidates remain immutable rollback artifacts until the client observation window closes.
- Source deletion happens only after replacement evidence, canary/soak, and rollback rehearsal. Local or untracked artifacts are never inferred as obsolete.

This map is approval evidence, not a license for a broad rewrite. Each implementation task must narrow it to the named symbols and callers for that task.

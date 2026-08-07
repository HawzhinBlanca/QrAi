# W2.17 impact map — inference, audio, privacy, and worker consolidation

Serena `find_referencing_symbols` mapped JavaScript callers; Rust LSP was unavailable, so the two
bounded Rust call families were read directly. No implementation symbol may be edited outside this
map without updating it and its tests first.

| Symbol/surface to change | Direct callers/consumers | Required preservation and proof |
|---|---|---|
| ML `normalizeArabic`, `similarity`, `alignWords`, `calculateConfidence` | ML runtime; alignment/golden tests | Move only; byte-identical Quran-stripping/alignment behavior; NFC invariant and golden tests |
| ML `analyzeAyah`, `analyzeWord` | `predictTajweed`; Tajweed/marks tests | Move only; escaped Arabic classes; instructional vs performance boundary unchanged |
| ML attribution exports | ML runtime; `server/src/lib/model-attribution.mjs`; finalization/provenance tests | One server-owned source; exact component/dataset/evidence validation |
| ML `predictAlignment`, `predictTajweed`, `transcribeSession` | old route; server/session/acoustic tests (including `acoustic-tajweed-boundary.test.mjs`); long-audio script; contract confidence/basis tests | Become injected runtime methods; exact refusals, output shapes, evidence, fixtures, limits; static boundary assertions require explicit store propagation while direct-only fallback composition remains lazy |
| ML window/WAV helpers and `loadSessionPcm` | transcript/acoustic tests; ASR/forced-align calls | Move to transcription/audio modules; bounded windows, gaps, hashes, sample rates, signal |
| ML `storeAudioChunk`, read/list/delete privacy, retention sweep | Rust gateway; Rust review/privacy; smoke/privacy/gateway/retention tests | One store; auth, create-only conflict, erase receipts, no PCM logging, one sweep owner |
| `createCompatibilityIngress` | `worker.main`, gateway harness, worker-listener tests; Rust platform ML/privacy/review/finalize and gateway audio writer | Closed measured-Rust allowlist on the worker listener; ML-key admission, bounded JSON/deadline, injected local inference/store, no PCM logging |
| `readAudioObject`/`exportPrivacy`/`deletePrivacy` compatibility methods | worker compatibility ingress; transitional Rust review/privacy consumers | Inject the worker-owned store; preserve retention refusal, tenant-scoped inventory, idempotent receipts, and fixed HTTP status semantics |
| ML `appendAudit`/read audit and HTTP `route`/rate limits | prediction/privacy responses; smoke/privacy/rate-limit tests | Worker-owned bounded audit and closed key-gated compat router; no tenant-wide unauthenticated read |
| `createWorkflowHandlers` | `createApplication`, `worker.main` | Worker remains sole caller after change; local inference dependency; privacy stays direct-store |
| `prepareSessionFinalization` | workflow `session.finalize` | Replace two ML HTTP calls with runtime methods; preserve preflight and fenced commit |
| `prepareSessionEvaluation` | workflow `session.evaluate` | Replace ML HTTP call; keep semantics validation, redaction, and fenced persistence |
| `capturePrivacyManifest` | `createPrivacyJob` for export/delete | Require the injected local store so an export cannot silently omit retained audio; preserve existence-before-storage ordering |
| `preparePrivacyWorkflow`/`eraseLearnerAudio` | workflow privacy kinds | Require the injected local store with no inference HTTP fallback; keep durable manifest-before-erase and retry receipt union |
| `runInlineJob` → `waitForJobResult` | `finalizeSession`, `proxyMl`, `createPrivacyJob`; API-wait and job-security proofs | Rename the stale inline executor surface to wait-only polling; API must never claim/execute work; deadline leaves job recoverable |
| `proxyMl` | Node alignment/Tajweed route wrappers | Session Tajweed remains durable; non-durable alignment crosses private worker client, not API CPU |
| `getFindingAudio` | route registry teacher-audio route | Remove production ML fallback; direct store, consent recheck, attempted→served audit unchanged |
| `createApplication`/`main` | Node process, shell/parity/lifecycle harnesses | Remove workflow/inference execution; retain only the private worker client needed by non-durable alignment |
| `worker.main`/`createJobWorker` | worker process/lifecycle tests; Compose | Compose local runtime + compat router + retention; bounded readiness, metrics, drain, cancellation |
| `createAudioObjectStoreFromEnv` | `main`, `worker.main`, inference runtime, storage/lifecycle tests | Server-owned development path; worker injects the single process store; inference fallback stays lazy for direct tests and cannot allocate storage or touch disk on import; production filesystem refusal and S3 encryption checks unchanged |
| `server/Dockerfile`/`server/package.json` | Node/worker builds; production-image and licence gates | Package inference assets/tests correctly; one dependency graph; no reverse-copy from old service |
| Rust platform ML/privacy/review/finalize URLs | current platform traffic and parity oracle | Repoint only to worker compat address; behavior remains oracle until W2.18 |
| Rust gateway ML URL/audio forward | current byte writer; gateway E2E | Preserve three attempts, store-before-index, forward/index metrics, and ML-key contract |
| Compose/release/smoke/load/evidence inventories | local stack, CI/release scripts, operations | Same server image for roles; remove separate ML image honestly; ASR remains independently gated |
| `smoke-all` service configs and `smoke-ml::startMlService` | aggregate smoke top level; API/privacy/ML smoke stages | Start the real job-worker compatibility address after migrations; isolated ML smoke may compose the exact production handler/runtime in-process, never the retired launcher |
| real-inference E2E/observability launchers | finalize, provenance, Tajweed, privacy, trace, overwrite/rate-limit/deadline proofs | Replace old process spawns with one test-only harness around the exact compatibility handler; preserve per-test env isolation and real audio/audit assertions |
| release image arrays and Docker workflow service loop | image build/prune, build evidence, signed manifest, smoke evidence and their tests | Remove only the retired ML deployable; retain platform, Node API, worker role image ownership, gateway, ASR, and web evidence |
| `scripts/verify.sh` and invocation guard | canonical local/CI gate | Register every new/relocated test exactly once; never weaken existing ML/gateway/E2E coverage |
| parity/E2E worker harnesses and `seedAcousticReviewFixtures` | direct/through-Node parity, ML/ASR proxy parity, Tajweed persistence effects, real-audio/provenance, durable/privacy/device suites | Start subject-scoped workers outside the API; local inference fixtures preserve proxy assertions; deterministic fixtures select the learner identity they assert instead of ambient row order |

## Required regression groups

- All relocated ML unit/contract suites and canonical NFC/source/learner-gate tests.
- Durable job concurrency/crash/fencing/dead-letter plus new API-wait and inference-cancellation tests.
- Real audio finalize, model provenance, audio lifecycle/playback, privacy journey, trace join, gateway
  retention/index-failure, Node/Rust parity, hostile input, secret logging, and dependency timeouts.
- Server production image, Compose topology, release manifest/image/build evidence, licences, build,
  live Rust integrations, direct/through-Node parity, and the exact canonical `verify.sh` command.

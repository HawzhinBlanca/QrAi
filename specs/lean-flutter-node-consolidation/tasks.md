# Task ledger — lean Flutter + Node consolidation

**Status:** approved; all tasks initially unchecked<br>
**Rule:** a checkbox may be changed only through `scripts/update-ledger.sh` after its named focused proof, `bash scripts/verify.sh`, and required CI checks are green. Release tasks additionally require protected `bash scripts/verify.sh --release` evidence. Human evidence never substitutes for an automated criterion, and automation never self-signs a human approval.

Implementation starts only after the approval header in `plan.md` is filled. Work one task at a time in this order unless an approved plan amendment changes dependencies.

## W0 — trustworthy evidence

- [x] W0.1 Test-first, repair route inventory as one green vertical slice: reproduce line/block-comment loss, replace the parser with lexical trivia handling, pin all 42 baseline pairs, add the two omitted audio operations to the contract, and correct current-count/cutover consumers. Proof: contract coverage/inventory, OpenAPI response validation, cutover self-test, mutation against the old parser, then the canonical gate. Criteria: CT-1, CT-2.
- [x] W0.2 Accept the route-retirement and contract-generation ADRs; generate a manifest distinguishing 42 baseline, four retirements, 38 retained baseline operations, and all explicit new operations; resolve the remaining permissive response contracts. Proof: `retired-routes.test.mjs`, route manifest and `openapi-completeness.test.mjs`. Criteria: CT-2, CT-3, CT-4.
- [x] W0.3 Relocate SQL migrations byte-identically, implement the checksum/advisory-lock/transaction ledger, and make Compose, CI, bootstrap, staging, restore, and release use it with the restricted role. Proof: migration runner, schema equivalence, Compose migration, DB enum/RLS parity. Criteria: DB-1, DB-2, DB-3.
- [x] W0.4 Wire the transitional Rust gateway to the API audio index and prove storage → index → teacher playback plus orphan telemetry/repair. Proof: `teacher-audio-index.test.mjs`, existing audio index/playback tests. Criteria: RT-4.

## W1 — real Quran-learning evidence

- [x] W1.1 Review and record the actual canonical corpus origin/provider/edition/license; choose the source-id migration without changing Arabic bytes. Proof: provenance review artifact plus `corpus-provenance.test.ts`. Criteria: QA-1.
- [x] W1.2 Add length-delimited ayah and word-token hashes to a new versioned manifest and DB seed path; preserve NFC vectors and checksum invariants. Proof: provenance, full-Quran, checksum, import, seed equality, and NFC tests. Criteria: QA-1.
- [x] **W1.3** Define component-level model attribution for ASR, forced aligner, Quran aligner, acoustic scorer, and calibrator; remove client-selected/fallback model authority. Proof: contract tests and a failing unknown/mismatched digest case. Criteria: QA-6.
- [x] **W1.4** Split ASR `/health` liveness from `/ready`; require the selected model digest and a bounded known-audio probe. Proof: `asr-readiness.test.mjs`, unloaded/failed/wrong-digest/recovery container cases. Criteria: QA-8, OP-4.
- [ ] **W1.5** Benchmark candidate ASR artifacts on held-out Quran recitation across approved accent/age/device/noise slices and pin the reviewed winner in the image. Proof: candidate-bound benchmark evidence; generic aliases cannot pass. Criteria: QA-7, QA-8.
- [ ] **W1.6** Extend ASR/forced alignment to return real recognized-token spans with absolute offsets and bounded-window composition. Proof: Python/ML unit tests for positive spans, offsets, refusal, and duration limits. Criteria: QA-2.
- [ ] **W1.7** Map recognized-token spans through Quran-constrained alignment and persist only evidence-backed canonical matches/misreads; omitted words receive no fabricated spans. Proof: alignment unit tests and `real-audio-finalize.test.mjs`. Criteria: QA-2.
- [ ] **W1.8** Round-trip real finalized spans, transcript source, component identities, artifact digests, and dataset identity through the restricted DB path. Proof: `model-provenance-roundtrip.test.mjs`, Rust/Node transition parity. Criteria: QA-2, QA-6.
- [ ] **W1.9** Reclassify canonical Tajweed text rules as instructional `text-rule` annotations with no learner-performance confidence. Proof: `tajweed-analysis-basis.test.mjs`, existing text-rule regression tests. Criteria: QA-3, QA-5.
- [ ] **W1.10** Select and implement one bounded acoustic learner-error pipeline consuming retained audio and server-derived spans; quarantine energy/F0/signal-presence heuristics from learner authority. Proof: correct-recitation, seeded-error, span-resolution, and refusal cases. Criteria: QA-3.
- [ ] **W1.11** Calibrate the acoustic score on held-out evidence and extend every server/contract/Flutter learner gate to require review, source, span/evidence id, model/dataset/calibrator identity, confidence, and audit id. Proof: `learner-feedback-gate.test.mjs`, `no-invented-confidence.test.mjs`, Dart gate tests. Criteria: QA-4, QA-5.
- [ ] **W1.12** Replace copied release metrics with a reproducible offline evaluator bound to immutable candidate/dataset/evaluator digests and signed evidence; mark all fixtures ineligible. Proof: evaluator unit tests and `model-evidence.test.mjs`. Criteria: QA-7.
- [ ] **W1.13** Add the deterministic golden regression to canonical verification with an explicit non-release claim. Proof: verify guard and fixture-label mutation. Criteria: QA-7.

## W2 — standalone production Node HTTP backend

- [x] **W2.1** Accept the backend-process, runtime-dependency, object-storage, timeout, rate-limit, and identity ADRs required by this wave. Proof: ADR/living-doc guard. Criteria: CL-3.
- [x] **W2.2** Create the server workspace package with production dependencies, ESM/type/lint policy, and testable composition root; move no behavior yet. Proof: workspace install/type/build and `standalone-lifecycle.test.mjs`. Criteria: BE-1.
- [x] **W2.3** Add a non-root locked production image, internal Compose service, health/readiness, SBOM/license/release entries, and clean-image smoke while traffic remains on Rust. Proof: Docker workflow, image test, release manifest. Criteria: OP-1, OP-2.
- [x] **W2.4** Move the existing Node API modules into the server package one coherent module at a time, preserving import/caller tests and proxy rollback mode. Proof: existing Node suites plus canonical gate per move. Criteria: BE-1, CL-1.
- [x] **W2.5** Port audio chunk indexing locally with full ticket/session/expiry/retention validation and idempotent writes. Proof: true Node `audio-index-parity`, wrong-session, retry, invalid-span, playback chain. Criteria: BE-1, RT-4.
- [x] **W2.6** Extract one transactional alignment persistence function and port session finalization without duplicating destructive realignment logic. Proof: consent/no-transcript/lost-chunk/server-derived/timeout tests. Criteria: BE-1, QA-2.
- [x] **W2.7** Port session Tajweed finding retrieval with unchanged learner redaction and tenant hiding. Proof: accepted/withheld/staff/cross-tenant parity. Criteria: BE-1, QA-4.
- [x] **W2.8** Add learner-owned session/history listing for delayed reviewed feedback; leave the staff listing privileged. Proof: own-only, pagination, cross-tenant 404, delayed-review E2E. Criteria: FL-5, DB-2.
- [x] **W2.9** Make route registration derive from one target registry and remove the duplicate portable allowlist after all retained HTTP operations are local. Proof: `route-registry.test.mjs`, standalone no-upstream test. Criteria: CT-3, BE-1.
- [x] **W2.10** Port maintenance, rate limits, proxy trust, origin/CORS, body limits, auth, error redaction, tracing, and metrics in the approved order. Proof: `middleware-order.test.mjs`, `node-boundary.test.mjs`, positive rate/maintenance tests. Criteria: BE-3.
- [x] **W2.11** Add restricted-role boot refusal and enforce `withTenant`/tenant transactions; prohibit raw DB imports outside storage/migration boundaries. Proof: `db-role-guard.test.mjs`, `db-tenant.test.mjs`, static architecture test. Criteria: DB-2.
- [x] **W2.12** Introduce shared abort/deadline budgets for Rust compatibility, ASR, object storage, privacy, review audio, workers, and Postgres. Proof: `dependency-timeouts.test.mjs` with hung/partial-state cases. Criteria: BE-4.
- [x] **W2.13** Implement bounded graceful HTTP shutdown and resource drain. Proof: child-process request/drain/pool/exit test. Criteria: BE-5.
- [x] **W2.14** Add S3-compatible private object storage plus filesystem test/dev adapter, server-derived keys, idempotent lifecycle, export/delete, and orphan reconciliation. Proof: `audio-lifecycle.test.mjs`, privacy/tenant/fault tests. Criteria: BE-6.
- [x] **W2.15** Add Postgres outbox/jobs for finalize, evaluation, retry, and privacy work with leasing/idempotency/dead-letter observability. Proof: job concurrency/crash/retry/exactly-once-effect tests. Criteria: BE-4, BE-6.
- [x] **W2.16** Implement owner-approved one-time device enrollment, server-derived role/tenant, credential rotation/revocation/expiry, and admin-provisioned staff. Proof: `device-enrollment.test.mjs` including reuse, expiry, forgery, and revocation. Criteria: BE-2.
- [ ] **W2.17** Fold load-bearing ML orchestration/audio/privacy modules behind local worker/storage interfaces; retain a key-gated compatibility endpoint for the Rust gateway during observation. Proof: relocated ML tests, privacy/audio/finalize E2E, worker cancellation/queue tests. Criteria: BE-1, BE-4, BE-6.
- [ ] **W2.18** Canary retained HTTP operations through Node, run effect/hostile-input/load/soak and rollback drills, and retain the Rust image for the observation window. Proof: candidate-bound canary/rollback evidence. Criteria: OP-3, GOV-1.

## W3 — Node realtime boundary

- [x] **W3.1** Accept the realtime-process/replay/backpressure ADR and freeze language-neutral `rt_v2`/`audio.ack` fixtures. Proof: ticket fixture parity. Criteria: RT-1.
- [x] **W3.2** Add the separate realtime entrypoint/process from the server package with independent readiness, metrics, failure isolation, and drain. Proof: realtime lifecycle/fault-isolation test. Criteria: BE-5, OP-4.
- [ ] **W3.3** Port signature, tenant/session/retention/expiry/origin/no-Origin validation and rate limits. Proof: `ticket-boundary.test.mjs`, hostile WebSocket vectors. Criteria: RT-1.
- [ ] **W3.4** Implement durable single-use nonce-hash replay protection across instances with TTL cleanup and fail-closed behavior; benchmark Postgres before removing Redis. Proof: concurrent cross-instance replay/load/failure test. Criteria: RT-1.
- [ ] **W3.5** Implement frame/payload/session ceilings, bounded per-session queues, explicit backpressure acknowledgments, sequence ordering, and overload metrics. Proof: `backpressure.test.mjs`, oversized/empty/reorder/100-session tests. Criteria: RT-2.
- [ ] **W3.6** Join storage and indexing idempotently and separately report stored-unindexed, accepted-lost, rejected, and repaired chunks. Proof: index failure, retention, playback, and repair E2E. Criteria: RT-3, RT-4.
- [ ] **W3.7** Define fresh-ticket reconnect, bounded retry/backoff/jitter, buffer ceiling, and honest stop/finalize fallback. Proof: `realtime-recovery.test.mjs`, chaos/long-audio cases. Criteria: RT-3.
- [ ] **W3.8** Run protocol parity, hostile input, fault, retention, load, and soak against the production Node realtime image. Proof: release-bound realtime evidence. Criteria: RT-1, RT-2, RT-3, RT-4.
- [ ] **W3.9** Canary realtime independently and rehearse endpoint rollback while the Node HTTP API remains active. Proof: canary/rollback evidence. Criteria: OP-3.

## W4 — complete the Kurdish-first Flutter product

- [ ] **W4.1** Accept the generated-client, localization governance, playback dependency, native enrollment, accessibility, and Flutter Web delivery ADRs. Proof: ADR/living-doc guard. Criteria: CL-3.
- [ ] **W4.2** Generate Dart client/models from the strict contract and replace handwritten boundaries incrementally without changing canonical bytes. Proof: Flutter contract, enum, model round-trip, and canonical-text tests. Criteria: CT-3, FL-2.
- [ ] **W4.3** Add ARB localization and a reviewer/source/version/completion/expiry capability manifest; fail closed on missing critical Sorani/Arabic keys. Proof: localization coverage and RTL journey tests. Criteria: FL-1.
- [ ] **W4.4** Acquire/review a licensed complete Sorani translation or constrain the product claim to the present reviewed coverage (Surahs 1, 2, 78–114). Proof: corpus coverage/reviewer manifest and release copy test. Criteria: FL-1, GOV-1.
- [ ] **W4.5** Connect reader passage/range selection directly to practice without retyping. Proof: reader-to-practice journey, range/CTA, canonical-byte tests. Criteria: FL-2, FL-3.
- [ ] **W4.6** Add licensed reference recitation, reviewed timings, word highlighting, and interruption-safe playback. Proof: timing/controller/interruption tests plus physical playback evidence. Criteria: FL-3, FL-9.
- [ ] **W4.7** Implement the lean listen → guide → record → correct → focused drill → complete loop with honest unavailable/pending states. Proof: `guided_practice_journey_test.dart`. Criteria: FL-3, QA-4.
- [ ] **W4.8** Write progress exactly once only after eligible server-finalized evidence and display the server schedule. Proof: `progress_write_test.dart`, API parity/concurrency. Criteria: FL-4.
- [ ] **W4.9** Add the learner feedback inbox/history with pending, approved, withheld/redacted, retry, and cross-device refresh states. Proof: `reviewed_feedback_inbox_test.dart` and delayed-review E2E. Criteria: FL-5.
- [ ] **W4.10** Replace the debug enrollment shortcut with the enrollment controller and platform-protected storage; rebuild session state; handle logout, 401, expiry, and revocation; embed no reusable access material. Proof: enrollment, transport, platform-storage, and signed-artifact scan tests. Criteria: FL-6, BE-2.
- [ ] **W4.11** Redesign `StreamingRecorder` around a fresh-ticket provider, bounded buffer, drop accounting, network recovery, batch fallback, and consent-preserving failure states. Proof: reconnect/batch/device failure tests and physical network-loss evidence. Criteria: FL-9, RT-3.
- [ ] **W4.12** Add teacher queue/session context/finding audio/provenance/span/accept-reject-edit; preserve edited wording separately. Proof: teacher journey, audio seek/no-audio, redaction, edit lineage, physical playback. Criteria: FL-7.
- [ ] **W4.13** Extend scholar approvals with immutable target hash and server-derived pending candidates, then add the minimal source/risk/audit/decision-history UI. Proof: migration/RLS/authz/parity and scholar journey tests. Criteria: FL-8.
- [ ] **W4.14** Complete permission, background, interruption, offline, cancellation, privacy, screen-reader, focus, RTL, and recoverable-error behavior. Proof: `device_failure_states_test.dart`, RTL/a11y matrices. Criteria: FL-1, FL-9.
- [ ] **W4.15** Build signed Android/iOS/Web candidates and execute the approved physical device/OS/microphone/network/accessibility/privacy matrix. Proof: `device-evidence.test.mjs` with signed, unexpired evidence. Criteria: FL-10, GOV-1.

## W5 — ASR final architecture decision

- [ ] **W5.1** Prove long-audio windowing/absolute offsets, worker capacity, queue overload, crash recovery, latency, and memory against the exact pinned production image. Proof: readiness/capacity/fault suite. Criteria: QA-2, QA-8, OP-4.
- [ ] **W5.2** Export and evaluate Node/ONNX and/or on-device candidates on the same held-out corpus, including accuracy, span error, calibration, latency, memory, battery, device coverage, privacy, and licensing. Proof: candidate-bound non-inferiority report. Criteria: QA-7.
- [ ] **W5.3** Accept an ADR selecting Node/on-device only if every approved threshold passes; otherwise record the isolated Python-worker exception. Proof: decision/evidence consistency test. Criteria: QA-7, QA-8.
- [ ] **W5.4** Move the selected inference path behind the final worker boundary and remove unselected runtime endpoints/images only after privacy/finalize/eval parity. Proof: final inference topology, audio/privacy, model evidence. Criteria: OP-1, QA-7.

## W6 — final release cutover

- [ ] **W6.1** Retarget root commands, Compose, CI, reverse proxy, smokes, release images, SBOM/licenses, monitoring, and runbooks to the candidate Flutter/Node/inference topology. Proof: `final-topology.test.mjs`, clean-clone CI. Criteria: OP-1, CL-3.
- [ ] **W6.2** Produce an immutable manifest binding source SHA, Flutter artifacts, Node image(s), inference/model/evaluator digests, migrations, SBOM, tests, and environment. Proof: `final-manifest.test.mjs`. Criteria: OP-2.
- [ ] **W6.3** Require deep readiness for DB, object storage, realtime/worker capacity, and loaded ASR while preserving process-only liveness. Proof: `deep-readiness.test.mjs`. Criteria: OP-4.
- [ ] **W6.4** Shadow safe reads and compare responses/effects without duplicating writes. Proof: shadow-diff/effect-isolation evidence. Criteria: OP-3.
- [ ] **W6.5** Canary a bounded cohort with automatic SLO/privacy/tenant/chunk/feedback/model stop conditions and a human GO decision. Proof: `canary-rollback-evidence.test.mjs`. Criteria: OP-3, GOV-1.
- [ ] **W6.6** Rehearse application rollback, forward-compatible migrations, object-store recovery, privacy retry, and timed Postgres restore. Proof: candidate-bound recovery/restore evidence. Criteria: OP-3.
- [ ] **W6.7** Obtain independent security, privacy, scholar, accessibility, mobile, SRE, and product signatures for the exact candidate. Proof: `human-signoffs.test.mjs`. Criteria: GOV-1.

## W7 — component retirement and final lean tree

- [ ] **W7.1** After Flutter native equivalence, remove Expo plus its workflow, commands, dependencies, tests, and current living-doc references; create no archive copy. Proof: retired-component/lean-tree tests and full gate. Criteria: CL-1, CL-2.
- [ ] **W7.2** Retire `tajweed-neural` unless selected by W5; remove its active architecture/release claims. Proof: final-topology and retired-component tests. Criteria: CL-1, OP-1.
- [ ] **W7.3** Remove the disconnected agents service; move only approved ordinary domain logic. Then, after data-retention/privacy approval, explicitly retire agent routes and deprecate/drop `agent_runs` through later additive migrations. Proof: retired routes, privacy export/delete migration, schema equivalence. Criteria: CT-4, CL-1.
- [ ] **W7.4** After Flutter Web/role/release equivalence and observation, remove React, nginx web image/config, dependencies, browser-only scripts/tests, and current references, replacing every operational proof first. Proof: Flutter Web smoke/a11y/security/release plus retired-component test. Criteria: CL-1, OP-1.
- [ ] **W7.5** After the Node HTTP observation window, remove only `services/platform-api`; convert oracle parity to permanent contract/effect regressions and keep the Rust gateway/shared ticket. Proof: standalone HTTP, rollback-window evidence, retired-component test. Criteria: BE-1, CL-1.
- [ ] **W7.6** After the independent realtime observation window, remove `services/realtime-gateway` and then `services/shared-ticket`; retain language-neutral fixtures. Proof: realtime release evidence and retired-component test. Criteria: RT-1–RT-4, CL-1.
- [ ] **W7.7** Remove the Cargo toolchain/audits only after no Rust crate remains; collapse transitional Node/ML directories into `server` one module at a time. Proof: workspace/build/release/lean-tree tests. Criteria: CL-1, CL-2.
- [ ] **W7.8** Write `docs/migration-summary.md`, retain commit ids/decisions/open risks, replace fragmented living docs with the approved final set, then remove obsolete active specs without a `legacy/` directory. Proof: `living-docs.test.mjs`, `spec-retirement.test.mjs`. Criteria: CL-3, CL-4.
- [ ] **W7.9** Run the final clean-clone canonical and release gates, verify the approved tracked tree, and attach all candidate-bound evidence. Proof: `lean-tree.test.mjs`, `final-topology.test.mjs`, full release gate. Criteria: OP-1–OP-4, CL-1–CL-4, GOV-1.

## Completion rule

The program is complete only when every applicable checkbox was ledger-updated after green proof, the final clean-clone and release gates are green, required CI checks are green, and human signoffs bind the exact immutable candidate. A smaller directory tree, passing mocks, or a local demo is not completion.

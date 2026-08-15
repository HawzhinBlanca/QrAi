# Acoustic evaluation and calibrated learner gate — implementation plan

**Status:** APPROVED FOR IMPLEMENTATION<br>
**Approved-by:** Repository owner ("approved", 2026-08-07)<br>
**Research:** `specs/acoustic-evaluation-calibration/research.md`

## Decision

Build one offline, candidate-bound evaluation authority and make every learner gate depend on its
verified calibration provenance. Keep W1.10 shadow output private until real evidence exists. Do not
create a second inference service, accept summary metrics, or seed a pretend passing evaluation.

## Ordered implementation

1. **Pin regression-only behavior (EV-6).** Add the existing computed
   `golden-regression.test.mjs` to canonical verification and assert its fixture cannot satisfy any
   release/calibration gate. Update testing docs; no metric is promoted.
2. **Define evidence format and ADR (EV-1–EV-3).** Add ADR-0049 and a strict versioned evidence
   schema. Required identities: candidate/model artifact SHA, dataset and split manifest SHA,
   evaluator source SHA/version, raw row-result SHA, optional calibrator SHA, eligibility, counts,
   reciter-disjoint slice metrics, uncertainty, timestamp, signer key id, detached signature.
3. **Implement the offline evaluator (EV-1–EV-3).** Add a Python CLI beside `eval_metrics.py` that
   accepts immutable row-level labels/scores/reciter/slice ids, verifies all input bytes, computes
   AUPRC/operating-point metrics/ECE/cluster CIs/agreement, and writes canonical evidence. It rejects
   aggregate-only input, missing classes/reciters, non-finite values, leakage, aliases, and fixtures
   claiming eligibility. Reuse numpy; add no runtime dependency.
4. **Verify signatures without repository secrets (EV-3/EV-5).** Add a Node verifier using built-in
   Ed25519 support. Production trust configuration contains public keys only and begins empty; tests
   generate ephemeral test keys whose signatures are always `test-only`. No private key, `.pem`, or
   hand-authored release evidence is committed.
5. **Persist provenance additively (EV-4).** Add migration `0031_evaluation_evidence_authority.sql`
   plus manifest checksum. Extend `eval_runs` with eligibility/kind and immutable evidence,
   candidate, dataset-manifest, split, evaluator, raw-result, calibration, signer, signature, counts,
   and slice fields. Historical rows become `fixture-regression`, `release_eligible=false`. Preserve
   existing RLS; prove fresh/upgrade/schema-equivalence and cross-tenant behavior.
6. **Expand contracts/readback (EV-4).** Extend TypeScript/OpenAPI/Rust/Node/Web EvalRun shapes and
   exact response parity. Remove the Web smoke branch that returns hand-authored perfect metrics;
   smoke uses a declared ineligible fixture response instead. Retire ML `createEvalRun` and its POST
   route as evaluation authority; replace smoke coverage with the offline evaluator/verifier.
7. **Make release claims evidence-bound (EV-5/LG-4).** Strengthen
   `modelEvalPassesReleaseGate` and `check-model-eval-claims` to require verified eligibility,
   digest equality, trusted non-test signer, required slices/counts, calibration metrics, and the
   approved numeric gates. Latest-row selection must not let a newer ineligible row hide an eligible
   one or vice versa; ambiguous/conflicting evidence fails closed.
8. **Add durable finding provenance (LG-1/LG-2).** In the same additive migration, add nullable
   historical fields to `tajweed_findings`: evidence id, dataset version/manifest digest, model
   artifact digest, calibrator id/digest, evaluation evidence digest. The linked alignment supplies
   the usable start/end span and retained-audio lookup. New acoustic rows require all fields and an
   exact active attribution chain; historical nulls remain withheld.
9. **Synchronize learner gates (LG-1/LG-2).** Extend contract fixtures/types/OpenAPI, Node
   persistence/redaction, Rust persistence/readback, and Flutter parsing/visibility. Remove score
   clamping and “sole tajweed model” selection. Missing or mismatched evidence rejects persistence;
   each independent client gate consumes the same expanded fixture corpus.
10. **Keep calibration fail-closed (LG-3/LG-4).** Add a calibrator registry/loader contract bound to
    scorer + dataset + evaluation digests, but configure no approved calibrator. W1.10 continues to
    emit only audit-safe shadow summaries and empty public findings until a separately reviewed
    evidence bundle and calibrator are supplied.
11. **Verify each task.** Add the named tests in `spec.md`; after every task run focused tests then
    `bash scripts/verify.sh`. Run `--release` only when trusted external evidence exists. Update the
    ledger solely through `scripts/update-ledger.sh` after canonical and required CI are green.

## Risks and mitigations

- **False authority:** fixture/test signatures, boolean `passed`, DB labels, or filenames never
  qualify; the verifier re-hashes exact bytes and validates a trusted signature.
- **Partial rollout:** all new finding fields are nullable for history but mandatory for new
  learner-performance writes; every missing field withholds.
- **Schema/API blast radius:** additive migration first, dual readers next, writers/gates last;
  preserve Rust/Node parity until cutover.
- **Human/data dependency:** software lands fail-closed. No task claims calibrated accuracy until
  real Kurdish-L1 adjudication, scholar review, threshold approval, and trusted signature exist.

## Approval gate

Fill `Approved-by:` above to authorize implementation. Until then, this plan changes no product code.

## Implementation evidence

- **T1 / EV-6 (2026-08-07):** the golden regression and its self-protecting invocation guard are in
  canonical verification; the fixture is explicitly ineligible for model evaluation, calibration,
  and release claims. Focused result: 15/15 passing. Canonical result: `bash scripts/verify.sh`
  exited 0 with `VERIFY OK`, including live-Postgres migration, RLS, API-parity, and persistence
  legs. The W1.13 ledger row remains open until required remote CI is green.
- **T2 / EV-1–EV-3 format (2026-08-07):** ADR-0049 and the strict JSON Schema 2020-12 evidence
  bundle define RFC 8785 canonical payload bytes, detached Ed25519 identity, immutable candidate/
  dataset/split/evaluator/raw-result/calibrator bindings, reciter-clustered uncertainty, slices,
  approvals, and closed eligibility. Focused result: 7/7 passing. Canonical result:
  `bash scripts/verify.sh` exited 0 with `VERIFY OK`, including live-Postgres legs. The ledger remains
  open pending required remote CI and real external evidence.
- **T3 / EV-1–EV-3 evaluator (2026-08-07):** the offline evaluator now verifies every declared
  input digest, rejects aggregate/aliased/leaky/fixture release input, computes metrics from strict
  row-level observations, and emits deterministic unsigned evidence with reciter-cluster bootstrap
  uncertainty. Focused results: evaluator 8/8, statistical core 27/27, schema/invocation 8/8.
  Canonical result: `bash scripts/verify.sh` exited 0 with `VERIFY OK`, including live-Postgres
  migration, RLS, API-parity, and persistence legs. The ledger remains open pending required remote
  CI, the signature authority, and real external evidence.
- **T4 / EV-3–EV-5 signature authority (2026-08-07):** the isolated Node verifier now validates
  the strict bundle, canonicalizes only well-formed JSON data with RFC 8785, re-hashes exact payload
  bytes, verifies detached Ed25519 signatures, and resolves active unique public JWKs from
  operator-owned trust. Ephemeral and fixture signatures cannot gain release trust; the committed
  production policy is public-only and empty. Focused result: 14/14 passing. Canonical result:
  `bash scripts/verify.sh` exited 0 with `VERIFY OK` under separate restricted runtime and
  administrative migration connections, including live-Postgres migration, RLS, API-parity, and
  persistence legs. The ledger remains open pending required remote CI and real external evidence.
- **T5 / EV-4 persistence authority (2026-08-07):** migration 0031 additively persists immutable
  evaluation evidence identity, provenance, eligibility, signatures, counts, and slice metrics,
  while historical aggregate rows remain explicitly ineligible. Tajweed findings gain an optional
  but all-or-nothing same-tenant evidence chain, and existing tenant RLS remains authoritative.
  Fresh install, upgrade, schema-equivalence, malformed/partial evidence, immutability, and
  cross-tenant behavior are pinned. Focused result: 27/27 passing. Canonical result:
  `bash scripts/verify.sh` exited 0 with `VERIFY OK` under separate restricted runtime and
  administrative migration connections, including 318 live-Postgres/API-parity tests, production
  build, bundle-secret scan, licence scan, and model-claim guard. The ledger remains open pending
  required remote CI, later implementation tasks, and real external evidence.
- **T6 / EV-4 contract and readback (2026-08-07):** the shared TypeScript/OpenAPI contract and
  Rust, Node, and Web readers now expose one strict 33-field EvalRun shape, including explicit
  eligibility and null historical provenance. Rust and Node are byte-identical for a complete
  declared fixture, and fixture/research rows cannot paint green browser benchmarks. The online ML
  eval POST/export and copied-metric authority are removed; ML smoke now runs the real offline
  evaluator, signs with an ephemeral in-memory test key, verifies the detached signature, and proves
  `releaseTrusted=false`. Focused results: contracts 36/36, Web data 9/9, ML/contract 39/39,
  report parity 11/11, historical API contract 1/1, plus live ML smoke. Canonical result:
  `bash scripts/verify.sh` exited 0 with `VERIFY OK` under separate restricted runtime and
  administrative migration connections. The ledger remains open pending required remote CI, later
  implementation tasks, and real external evidence.
- **T7 / EV-5/LG-4 release authority (2026-08-07):** the shared release gate now consumes the
  verifier's immutable exact payload and requires release-class trust, matching signature/digest/
  artifact/dataset/evaluator/raw/calibrator identities, row/count/slice equality, at least 18
  reciters, reciter-cluster bootstrap uncertainty, source-backed acoustic findings, calibration,
  and task-specific approved metrics. The database guard considers all tenant-visible history:
  fixtures/research cannot hide valid evidence, while invalid release-labelled or multiple distinct
  authorities fail closed. Migration 0032 additively demotes the remaining aggregate-only
  `eval-passed` seed because production trust is empty. Focused results: release/selection/guard
  24/24, contracts 36/36, migration/schema 12/12, TypeScript typecheck, checker self-test, and live
  restricted-role checker all pass. Canonical result: `bash scripts/verify.sh` exited 0 with
  `VERIFY OK`, including 603 Node checks, 99 Rust/Postgres integration tests, 369 Rust/Node parity
  tests, 319 through-Node cutover tests, the production build, licence/security scans, and the live
  claim guard. The ledger remains open pending required remote CI, later implementation tasks, and
  real external evidence.
- **T8 / LG-1/LG-2 durable finding authority (2026-08-07):** migration 0033 now rejects every new
  acoustic finding unless all seven provenance fields exactly match one same-tenant, same-model,
  passed release-candidate acoustic evaluation. Historical null-provenance rows remain readable,
  reviewable, deletable, and withheld. Rust and Node writers no longer clamp confidence or infer a
  producer from the sole Tajweed model; they validate and persist exact model/artifact/dataset/
  calibrator/evaluation identities before writing an audit row. All direct integration, parity, and
  E2E acoustic seeds now use one explicitly test-only DB-mechanics fixture whose ancient timestamp
  cannot take over latest-evaluation reads and whose signer can never satisfy production trust.
  Focused results: migration/schema 13/13, live Rust/Postgres integration 99/99, persistence/E2E
  6/6. Canonical result: `bash scripts/verify.sh` exited 0 with `VERIFY OK`, including 604 Node
  checks, 99 live Rust/Postgres integration tests, 369 Rust/Node parity tests, 319 through-Node
  cutover tests, build, licence/security scans, and the live claim guard. The ledger remains open
  pending remote CI, synchronized reader/client gates, and real external evidence.
- **T9 / LG-1/LG-2 synchronized learner gates (2026-08-07):** contracts, OpenAPI, Node, Rust,
  Web, and Flutter now consume one 26-vector learner-feedback corpus and require the complete
  acoustic review, source, retained-audio span, model, dataset, calibrator, evaluation, and audit
  chain. Historical, fixture, stale, discarded-audio, and uncalibrated findings remain visible to
  staff but are redacted for learners; teacher review cannot override another missing gate.
  Focused results: contracts 36/36, Web 198/198, shared Node/TypeScript corpus 26/26, Rust corpus
  and live readback checks green. Flutter source/contract parity is green; device execution remains
  explicitly skipped because no Flutter SDK is installed. Canonical result: `bash scripts/verify.sh`
  exited 0 with `VERIFY OK`, including 609 Node checks (607 passed, one expected TODO and one
  skip), 99 live Rust/Postgres integration tests, 369 direct parity tests, 319 through-Node tests,
  build, licence/security scans, and the live claim guard. The ledger remains open pending remote
  CI, the fail-closed calibrator task, and real external evidence.
- **T10 / LG-3/LG-4 fail-closed runtime calibration (2026-08-07):** the ASR service now loads one
  closed calibrator registry whose active record must resolve uniquely, use an approved method,
  name a safe byte-pinned artifact, and exactly bind the scorer artifact, dataset manifest, and
  verified evaluation-evidence digests. The committed registry has no records or active authority;
  the ineligible shadow candidate refuses activation, Python attribution remains explicitly
  uncalibrated, and Node continues to expose audit-safe counts with public `findings: []`. Both ASR
  image targets include the loader and registry. Focused results: Python acoustic/attribution 21/21,
  Node runtime plus boundary contracts 28/28, and both Docker target checks green. Canonical result:
  `bash scripts/verify.sh` exited 0 with `VERIFY OK`, including 610 Node checks (608 passed, one
  expected TODO and one skip), 99 live Rust/Postgres integration tests, 369 direct parity tests,
  319 through-Node tests, build, licence/security scans, and the live model-claim guard.
- **Final verification boundary (2026-08-07):** all locally implementable software tasks in this
  approved plan are canonical-green. No ledger checkbox was changed: W1.11 still requires an
  eligible consented/adjudicated Kurdish-L1 corpus, scholar-approved QPS profile, approved
  threshold/calibrator artifact, trusted external signing authority, required CI, and real device/
  candidate proof. The repository fails closed until those inputs exist; it makes no acoustic
  accuracy or release-readiness claim.

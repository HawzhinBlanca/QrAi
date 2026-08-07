# Acoustic evaluation and calibrated learner gate — research

**Date:** 2026-08-07<br>
**Scope:** W1.11–W1.13 evidence authority after the W1.10 shadow boundary. Research only.

## Current data flow

1. `services/asr-inference/acoustic_tajweed.py::AcousticEngine.observe` emits internal
   `calibrationStatus=uncalibrated` observations; `model_attribution.py::build_acoustic_attribution`
   declares the calibrator unavailable.
2. `services/ml-inference/server.mjs::predictTajweed` records only a bounded shadow summary and
   deliberately returns `findings: []`; this is the correct W1.10 fail-closed state.
3. If findings ever appear, Node `proxyMl` calls `persistTajweedFindings`, which links a word
   alignment but selects the sole `kind='tajweed'` model, clamps any finite score into `[0,1]`, and
   stores no dataset, calibrator, evidence-artifact, or span identity on `tajweed_findings`.
4. Learner visibility is independently copied in contracts `canShowLearnerFacingAiOutput`, Node
   `clearsLearnerGate`, Rust `clears_learner_gate`, and Dart `TajweedFinding.isLearnerVisible`.
   Each requires only acoustic basis, approved status, confidence `>=0.82`, and one source.
5. Node `redactWithheldFindings`, Rust session-finding readback, and Flutter `TajweedPanel` consume
   that four-term decision. `tests/contract/tajweed-gate-parity.test.mjs` pins the copies.

## Evaluation authority today

- `services/ml-inference/server.mjs::createEvalRun` recomputes only source count; its accuracy
  numbers come from `fixtures/golden-evals.json` and it exposes a private POST `/v1/eval-runs`.
- `ModelEvalRun`, OpenAPI `EvalRun`, Rust `types.rs::EvalRun`, and SQL `eval_runs` carry aggregate
  metrics plus model/dataset labels, but no artifact, manifest, evaluator, split, reciter, subgroup,
  calibration, signature, or approval binding.
- `scripts/check-model-eval-claims.mjs::claimProblem` calls the numeric threshold gate on the latest
  tenant-visible row; therefore a passing fixture-shaped row can support `eval-passed` without
  proving what executable, corpus, split, or evaluator produced it.
- `services/asr-inference/eval_metrics.py` is a trustworthy pure-statistics core: AUPRC, ROC AUC,
  operating-point precision/recall/F1, ECE, reciter-cluster bootstrap, and annotator agreement have
  known-answer tests in `test_eval_metrics.py`.
- `services/ml-inference/golden-regression.test.mjs` computes deterministic fixture behavior, labels
  it non-release, but is absent from the canonical `scripts/verify.sh` Node invocation.
- Staff reads flow through Rust `get_eval_run`, Node `getEvalRun`, API parity, and Web `fetchEvalRun`;
  every consumer assumes the weak shape, and Web smoke mode fabricates a perfect passing result.

## Required integration surface

- Contracts/OpenAPI/canonical gate corpus; additive SQL migration + RLS/schema equivalence; Rust and
  Node eval readback; model-claim checker; release manifest/gate; evaluator CLI and evidence schema.
- Acoustic finding persistence/readback; exact model-attribution chain; teacher decision; Flutter
  parser/gate/panel; Node/Rust/Dart parity fixtures.
- Callers mapped with Serena: `canShowLearnerFacingAiOutput` → two contract suites;
  `modelEvalPassesReleaseGate` → contract suites + model-claim checker; `clearsLearnerGate` → Node
  redaction; `persistTajweedFindings` → `proxyMl`; `createEvalRun`/`predictTajweed` → private router.

## Risks and hard boundaries

- No held-out Kurdish-L1 adjudicated corpus or approved calibrator exists: implementation must build
  fail-closed evidence machinery, never fabricate metrics or promote W1.10 observations.
- Fixtures must remain regression-only and mechanically incapable of clearing a release/calibration
  gate. A boolean `passed`, self-asserted signature, filename, or mutable DB label is insufficient.
- New tenant-owned evidence tables require RLS; historical migrations/canonical bytes are immutable;
  raw audio and canonical Quran text must never be logged, normalized, or rewritten.
- Gate expansion is a synchronized contract/DB/Rust/Node/Dart change; partial rollout must withhold,
  not silently default missing provenance.

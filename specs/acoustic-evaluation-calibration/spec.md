# Acoustic evaluation and calibrated learner gate — specification

**Status:** Proposed<br>
**Scope:** W1.11–W1.13. This does not assert that an eligible Kurdish-L1 corpus, calibrator, or
human approval already exists.

## Acceptance criteria

- **EV-1:** WHEN an evaluator receives aggregate metrics, a mutable model alias, a fixture-only
  corpus, or any digest-mismatched artifact, THE evaluator SHALL reject it as release evidence.
  Test: `services/asr-inference/test_eval_pipeline.py`.
- **EV-2:** WHEN an immutable row-level label/score manifest is evaluated, THE evaluator SHALL
  compute metrics from those rows, use reciter-clustered uncertainty, and emit deterministic output
  without trusting caller-supplied summary numbers. Test: `test_eval_pipeline.py`.
- **EV-3:** WHEN evidence is emitted, THE evidence bundle SHALL bind the exact candidate artifact,
  dataset manifest, split manifest, evaluator source, calibration artifact (when applicable), raw
  result digest, counts/slices, and detached signer identity. Test: `tests/release/model-evidence.test.mjs`.
- **EV-4:** WHEN evaluation evidence is persisted and read, THE API SHALL round-trip the exact
  provenance through tenant RLS without defaults or cross-tenant visibility. Tests:
  `tests/migrations/eval-evidence-migration.test.mjs`, `tests/api-parity/reports-parity.test.mjs`.
- **EV-5:** WHEN a model claims `eval-passed` or `released`, THE release checker SHALL require one
  signature-verified, held-out, release-eligible evidence bundle whose digests and metrics match the
  database row; fixture/test keys SHALL never qualify. Test: `tests/release/model-evidence.test.mjs`.
- **EV-6:** WHEN `scripts/verify.sh` runs, THE deterministic golden regression SHALL run and remain
  explicitly ineligible for model, calibration, or release claims. Tests:
  `services/ml-inference/golden-regression.test.mjs`, `tests/contract/verify-invocations.test.mjs`.
- **LG-1:** WHEN any Tajweed finding is considered for learner display, THE contracts, Node, Rust,
  and Dart gates SHALL require acoustic basis, approved review, calibrated confidence, sources,
  usable retained-audio span, evidence id, exact model/artifact/dataset/calibrator/evaluation
  identity, and audit id. Test: `tests/contract/learner-feedback-gate.test.mjs`.
- **LG-2:** WHEN any required learner-evidence field is absent, malformed, stale, fixture-bound, or
  mutually inconsistent, THE system SHALL reject persistence or redact/withhold the finding; it
  SHALL NOT clamp a raw score into confidence or guess the producing model. Tests:
  `learner-feedback-gate.test.mjs`, `tests/api-parity/tajweed-persistence-effects.test.mjs`.
- **LG-3:** WHEN no approved calibrator is available or its digest does not match the selected
  acoustic scorer/evaluation, THE W1.10 adapter SHALL remain shadow-only and public `findings[]`
  SHALL remain empty. Tests: `services/asr-inference/test_acoustic_tajweed.py`,
  `services/ml-inference/acoustic-shadow.test.mjs`.
- **LG-4:** WHEN eligible human-adjudicated evidence or required approval is absent, THE system SHALL
  retain `shadow-only`/`draft` status and SHALL NOT manufacture a passing run, calibrated confidence,
  signature, or learner feedback. Tests: `model-evidence.test.mjs`, `check-model-eval-claims --self-test`.

## Completion boundary

The software machinery can be completed locally, but W1.11 cannot be marked complete until the
owner supplies an eligible consented/adjudicated Kurdish-L1 corpus, scholar-approved QPS profile,
approved thresholds, and trusted human signing/approval evidence for the exact candidate.

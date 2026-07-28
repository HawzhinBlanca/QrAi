# Kurdish-L1 Quranic Recitation Evaluation Protocol

**Status:** DRAFT — awaiting owner + scholar + legal approval before any data collection
**Satisfies:** readiness ledger **P3.4** (protocol definition). **P3.5** (execution) requires this approved + real data collected.
**Written against:** `services/asr-inference` at commit `e0f37c1`
**Author:** engineering. **Requires sign-off from:** owner (P0.1), scholar (P3.6), legal/privacy (P4.6).

---

## 0. Prior art warning — do not reuse the existing eval

`scripts/evaluate-model.mjs` **does not evaluate anything**. It generates results with `Math.random()`
and writes them to `specs/number-one-release/evaluation-results.md`, which reports
"Word Alignment F1 `0.9973` **PASSED**", "Tajweed F1 `0.9964` **PASSED**", and a
"Kurdish Sorani | 150 samples | 0.910" row. The dataset it names
(`fatihah-juz-amma-reviewed-v1`, 500 sessions) **does not exist** — there are zero audio files in
the repository.

**Those numbers are not measurements and must never be cited as evidence.** This protocol
replaces them. Recommended action: delete or quarantine both files before anyone mistakes them
for real results.

---

## 1. Why this study exists

It answers two questions with one data collection:

**Q-A (strategic).** Does the current ASR stack perform *materially worse* for Kurdish-L1 reciters
than for Arabic-L1 reciters? If yes, a Kurdish-specific fine-tune is a real, defensible product
moat. If no, investment should go to the pedagogy and scholar-review layer instead.

**Q-B (readiness).** Is the learner-facing feedback accurate enough to show a learner at all?
This is the evidence P3.4/P3.5 demand, and it is currently the only *measurable* thing blocking
"learns well."

**Critical framing:** the ASR task is **Quranic Arabic**, not Kurdish. Kurdish learners recite in
Arabic. This study measures *Kurdish-L1-accented Quranic Arabic*, which is a far narrower and more
tractable problem than "Kurdish ASR."

---

## 2. System under test

Three components, evaluated separately — they fail in different ways.

| # | Component | Endpoint | Nature |
|---|-----------|----------|--------|
| 1 | Transcription | `/transcribe` | `tarteel-ai/whisper-base-ar-quran`, Whisper fallback |
| 2 | Word alignment | `/force-align` | CTC forced alignment → per-word `(start_ms, end_ms, score)` ([forced_align.py:42](../../services/asr-inference/forced_align.py#L42)) |
| 3 | Tajweed detection | `/analyze-tajweed` | **Hand-tuned acoustic heuristics** ([server.py:599-674](../../services/asr-inference/server.py#L599)) |

Component 3 is not a trained model. Its "confidence" values are monotone rescalings of a single
acoustic feature each — e.g. `min(0.95, 0.6 + word_duration * 0.5)` for madd-tabii, F0 standard
deviation for ghunnah, frame energy for qalqalah. **They are not calibrated probabilities**, so any
threshold on them is arbitrary until measured. This protocol treats that as a hypothesis to test,
not a defect to assume.

---

## 3. The auto-correction trap — why WER is the WRONG primary metric

**This is the single most important design decision in this document.**

Whisper-family models have effectively memorized the Quran. Given audio of a learner reciting
Al-Fatihah *with mistakes*, the model's language-model prior will overwhelmingly tend to emit the
**correct canonical text anyway**.

Consequence:

- Word Error Rate will look excellent — possibly near zero.
- Error-detection recall may be near zero at the same time.
- **A low WER is therefore actively misleading for a teaching app.** It measures how well the model
  reproduces text it already knows, not whether it noticed what the learner did wrong.

A teaching app's job is the opposite of a transcription app's job: it must *refuse* to auto-correct.

**Therefore the primary signal is the per-word alignment score from `/force-align`, not the
transcript.** Forced alignment is constrained to the canonical text, so it cannot "fix" a
mispronunciation; a badly pronounced word instead receives a low alignment probability. That score
is the detector under evaluation.

> **EARS:** WHEN a learner mispronounces a word, THE evaluation SHALL score the system on whether
> the per-word alignment probability for that word is separable from correctly-pronounced words —
> and SHALL NOT credit the system for transcribing the canonical text correctly.

WER is still reported, as a **secondary diagnostic only**, explicitly flagged as non-decisional.

---

## 4. Predeclared metrics

Declared before collection. No metric may be added, swapped, or re-thresholded after unsealing
(§8). Any deviation is recorded as a protocol amendment with date and reason.

### 4.1 Primary — mispronunciation detection (answers Q-A)

Treat the per-word alignment score as a binary detector of gold-labeled mispronunciation.

- **Primary metric: AUPRC** (area under precision-recall curve), per cohort.
  Chosen over F1 because no operating threshold has been set yet, and because errors are the
  minority class — AUPRC is threshold-free and robust to class imbalance. AUC-ROC reported alongside.
- **Primary comparison:** `AUPRC(Arabic-L1) − AUPRC(Kurdish-L1)`.
- **Uncertainty:** 95% CI by **reciter-level bootstrap** (resample reciters, not words — words within
  a reciter are correlated; see §9).

**Predeclared decision thresholds for Q-A:**

| Outcome | Interpretation | Action |
|---|---|---|
| ΔAUPRC ≥ 0.05, 95% CI excludes 0 | Kurdish-specific gap **confirmed** | Fine-tuning wedge is real — invest |
| ΔAUPRC < 0.05, or CI includes 0 | No detectable Kurdish-specific gap | Redirect investment to pedagogy + scholar layer |
| Both cohorts' AUPRC < 0.60 | Detector is weak **for everyone** | Model work needed regardless of Kurdish question |

That third row matters: it is a genuinely possible outcome and it changes the roadmap more than
either of the first two.

### 4.2 Secondary — tajweed heuristic validity (answers Q-B)

Per rule (`madd-tabii`, `ghunnah`, `qalqalah`, …), against qari gold labels:

- **Precision, recall, F1** at the current shipped thresholds.
- **Calibration: Expected Calibration Error (ECE)** + reliability diagram. Included specifically
  because §2 predicts these confidences are uncalibrated. **A poor ECE here is an expected finding,
  not a surprise** — it tells you the number shown to a learner is not a probability.
- **Predeclared gate:** any rule with **precision < 0.70** on held-out data **must not reach a
  learner**, irrespective of scholar approval. Scholar approval governs doctrinal correctness;
  this gate governs measurement reliability. Both are required.

### 4.3 Diagnostic — the Kurdish phonological hypothesis

**Predeclared hypothesis:** Kurdish-L1 reciters show elevated error and confusion rates on Arabic
pharyngeal and emphatic consonants absent from Kurdish phonology — **ع ح ق ط ص ض ظ غ** — with
expected substitutions toward ء ه ك ت س د/ز ز.

Reported as a per-phoneme confusion matrix. This is the *mechanism* behind Q-A: it tells you what a
fine-tune would actually need to learn, and it is the input to the Sorani/Badini pedagogy content.
Exploratory — reported with explicit multiple-comparison caution, never used as the primary gate.

---

## 5. Cohorts, slices, and sample size

### 5.1 Cohorts

| Cohort | Role | Target n (reciters) | Minimum n |
|---|---|---|---|
| Kurdish-L1 — **Sorani** | Primary pilot demographic (Erbil) | 30 | 18 |
| Kurdish-L1 — **Badini** | Second Kurdish phonology | 15 | 8 |
| **Arabic-L1** | Reference baseline for Q-A | 30 | 18 |

Badini is deliberately included: treating "Kurdish" as one phonological group is an assumption this
study should test, not inherit.

### 5.2 Stratification within each cohort

- **Skill:** beginner / intermediate / advanced-hafiz. **Beginners are the most valuable slice** —
  a corpus of only huffaz contains almost no errors and cannot measure a detector. Target ≥40%
  beginner.
- **Age:** adult / child (child requires guardian consent, §6).
- **Gender:** balanced where consent permits; see §6.3.
- **Recording condition:** quiet room / typical madrasa ambient — both on ordinary phone mics, since
  that is the real deployment device.
- **Style:** murattal (slow) and hadr (fast).

### 5.3 Sample size justification

Power calculation for the primary comparison, framed as a two-proportion test on error-detection
recall (0.70 vs 0.55, Δ=0.15, α=0.05 two-sided, power=0.80):

```
n = (1.96 + 0.84)² × [0.70(0.30) + 0.55(0.45)] / 0.15²
  = 7.84 × 0.4575 / 0.0225
  ≈ 160 error-bearing words per cohort
```

Words cluster within reciters. With ~20 error-bearing words per reciter and an assumed
ICC ≈ 0.10, the design effect is `1 + (20−1)(0.10) = 2.9`:

```
effective requirement ≈ 160 × 2.9 ≈ 464 error-bearing words per cohort
                      ≈ 23 reciters per cohort
```

Hence **target 30, minimum 18** per primary cohort. ICC is an assumption — recompute it from the
first 10 reciters and revise the target before completing collection.

### 5.4 Ensuring errors exist in the corpus

A detector cannot be measured without positives. Two sources, **recorded and analysed separately**:

1. **Natural errors** — beginner reciters making genuine mistakes. Ecologically valid; yield
   unpredictable.
2. **Elicited errors** — a script asking reciters to read specified ayahs with specified
   substitutions (e.g. ع→ء).

Elicited errors guarantee coverage of the §4.3 phoneme set, but shift the error distribution.
**Primary metrics are computed on natural errors only.** Elicited data is used for the phoneme
confusion diagnostic and is always labelled as such.

---

## 6. Consent and data governance

Eval-corpus consent is **separate and stricter** than ordinary app-usage consent, because eval audio
is retained long-term while practice audio may be discard-on-process
(`mustDiscardAudio`, `audio_retention`).

### 6.1 Required consent elements

Reusing the existing schema (`recordingConsent`, `audioRetention`, `anonymizedLearning`,
`externalAsrProcessing`, `guardianApproved`, `consentVersion` — new version: `eval-kurdish-v1`):

- Explicit, separate opt-in to **long-term retention in a research corpus**.
- Purpose stated plainly: improving recitation feedback for Kurdish speakers.
- Named retention period and deletion path.
- Explicit statement of who may listen (named annotator roles, not "our team").
- Withdrawal instructions that work after the fact.
- Delivered in **Sorani and Badini**, not only Arabic or English.

### 6.2 Minors

Beginner slices will include madrasa students. Guardian consent is **mandatory and documented**
(`guardian_approved`), with child-appropriate assent language in addition to the guardian's consent.
Any recording lacking verified guardian consent is excluded — no exceptions, no retrospective cures.

### 6.3 Gender and cultural sensitivity

Recording and replaying women's recitation carries religious and cultural sensitivity in the pilot
region. The protocol therefore requires:

- Explicit, granular opt-in specifying who will hear the recording.
- The option to request **gender-matched annotators**, honoured operationally.
- Withdrawal without any effect on the participant's access to the app.

If balanced gender representation cannot be achieved under genuine consent, **report the imbalance
as a stated limitation — do not coerce participation and do not silently skew the corpus.**

### 6.4 Right-to-erasure vs reproducibility — resolve BEFORE collection

Genuine tension: an erasure request mutates a frozen held-out set and breaks reproducibility.

**Recommended policy (requires legal sign-off, P4.6):** on erasure request, delete the audio and all
PII immediately; retain derived, non-identifying, non-invertible features and labels under a
documented lawful basis; publish a dataset version bump recording that removal, so prior results
remain interpretable and clearly attached to a superseded version.

Participants must be told this **before** consenting. If legal rejects this, the fallback is full
removal plus re-release — pick one before recording, never after.

---

## 7. Gold labelling

The measurement ceiling is human agreement. If annotators disagree with each other, no model can
be shown to agree with "the truth."

- **Annotators:** ≥2 independent, qualified (hafiz/qari; ijazah preferred), per utterance.
  Third qualified adjudicator resolves disagreements.
- **Blinding — mandatory:** annotators must **never** see model output before labelling. Anchoring
  would silently inflate every agreement number. (The fabricated legacy report's "Teacher Agreement
  Rate 0.932" is exactly the shape of number this protects against.)
- **Label schema:** per word — `correct | mispronounced | omitted | inserted`, plus, where
  applicable, the tajweed rule implicated and a severity.
- **Inter-annotator agreement: Krippendorff's α**, reported *before* any model metric.
  - α ≥ 0.80 → labels are solid.
  - 0.67 ≤ α < 0.80 → usable, report as a limitation.
  - **α < 0.67 → STOP.** The labelling task is ill-defined. Fix the rubric and retrain annotators
    before evaluating the model. Do not report model metrics against labels this noisy.

---

## 8. Splits and sealing

- **Split by reciter, never by utterance.** The same speaker appearing in both dev and held-out is
  leakage and would inflate results.
- **dev (~40%)** — free iteration. **held-out (~60%)** — touched **once**.
- Stratification (§5.2) preserved across both splits.
- **Sealing:** before any model work, commit a manifest of held-out reciter IDs + a SHA-256 of the
  audio manifest to git. The commit timestamp is the evidence the set predates the analysis.
- The analysis script is written and committed **before** unsealing.
- **One unsealing.** A second look requires a new held-out set and is recorded as such.

---

## 9. Analysis plan (predeclared)

1. Report Krippendorff's α first. If < 0.67, stop (§7).
2. Compute per-cohort AUPRC / AUC-ROC for alignment-score error detection.
3. Compute ΔAUPRC with **reciter-level bootstrap** 95% CI (10,000 resamples, resampling *reciters*).
4. Apply the §4.1 decision table.
5. Compute per-rule tajweed precision/recall + ECE; apply the §4.2 precision-0.70 gate.
6. Produce the §4.3 phoneme confusion matrix (exploratory; multiple-comparison caution stated).
7. Subgroup reporting by skill, age, gender, dialect, recording condition — **reported even when
   inconvenient**, with CIs, and never silently dropped for small n (report n instead).
8. Report WER last, explicitly labelled **non-decisional** (§3).

Statistical software and seed are pinned and committed. The analysis is re-runnable end to end from
the corpus by a third party — that is what makes it evidence rather than assertion.

---

## 10. Threats to validity (stated up front)

| Threat | Mitigation |
|---|---|
| **Auto-correction trap** — WER flatters a model that ignores errors | Primary metric is alignment-based, not transcript-based (§3) |
| **Annotator anchoring** | Mandatory blinding (§7) |
| **Reciter leakage across splits** | Reciter-wise splitting (§8) |
| **Volunteer selection bias** — volunteers skew skilled and male | Quota-based recruitment; report residual imbalance as a limitation (§6.3) |
| **Elicited-error distribution shift** | Primary metrics on natural errors only (§5.4) |
| **Clustering ignored → false confidence** | Reciter-level bootstrap; design-effect-adjusted n (§5.3, §9) |
| **Uncalibrated tajweed confidence** | ECE measured and reported; predicted in advance (§4.2) |
| **Dialect essentialism** — treating "Kurdish" as one group | Sorani and Badini analysed separately (§5.1) |

---

## 11. Re-evaluation triggers

The result expires. Re-run when **any** of:

- ASR model or model version changes (including a Whisper upgrade).
- Alignment or tajweed thresholds change.
- A new dialect or L1 cohort is added.
- **12 months** elapse.
- Production monitoring shows distribution shift vs the corpus.
- Any incident where a learner reports feedback that was confidently wrong.

---

## 12. What this study does NOT establish

Stating this prevents the result from being over-claimed later:

- **Not doctrinal correctness.** Whether a tajweed ruling is *right* is a scholar's determination
  (P3.6), not a metric. High precision against gold labels ≠ religious validity.
- **Not pedagogical effectiveness.** Whether learners actually improve requires a learning-outcomes
  study (P6.5).
- **Not a licence to remove the human review gate.** `canShowLearnerFacingAiOutput` stays as-is.
  Good metrics narrow what needs review; they do not eliminate review.
- **Not a general claim about Kurdish speech.** This measures Kurdish-L1-accented *Quranic Arabic*
  recitation only.

---

## 13. Acceptance criteria (EARS)

- WHEN the corpus is collected, THE protocol SHALL have ≥18 reciters per primary cohort with ≥40%
  beginner representation.
- WHEN any recording involves a minor, THE system SHALL have a verified guardian consent record, or
  the recording SHALL be excluded.
- WHEN gold labels are produced, THE protocol SHALL report Krippendorff's α before any model metric,
  and SHALL halt if α < 0.67.
- WHEN the held-out set is created, THE manifest hash SHALL be committed to git before any model
  work begins.
- WHEN results are published, THE report SHALL include per-cohort AUPRC with reciter-level bootstrap
  CIs, per-rule tajweed precision and ECE, and all §5.2 subgroup breakdowns.
- WHEN a tajweed rule scores precision < 0.70 on held-out data, THE system SHALL NOT surface that
  rule to a learner.
- WHEN a participant requests erasure, THE system SHALL delete audio and PII and SHALL publish a
  dataset version bump.

---

## 14. Execution sequence

| # | Step | Owner | Gate |
|---|------|-------|------|
| 1 | Approve this protocol | owner + scholar + legal | **blocks everything** |
| 2 | Finalize consent copy in Sorani + Badini | legal + translator | blocks recruitment |
| 3 | Recruit + stratify cohorts | pilot coordinator | — |
| 4 | Collect audio | pilot coordinator | consent verified per recording |
| 5 | Recompute ICC from first 10 reciters; revise target n | engineering | before completing collection |
| 6 | Blinded gold labelling, ≥2 annotators | qari annotators | α ≥ 0.67 |
| 7 | Seal held-out manifest to git | engineering | before any model work |
| 8 | Commit analysis script | engineering | before unsealing |
| 9 | Unseal once, run analysis | engineering | — |
| 10 | Publish model card, error analysis, limitations | engineering + scholar | closes **P3.5** |

Steps 1–2 are human-gated and are the current blockers. Steps 5, 7, 8, 9 are machine work that can
be built and tested against synthetic fixtures **before** real audio exists — that is the honest way
to prepare while waiting for approval.

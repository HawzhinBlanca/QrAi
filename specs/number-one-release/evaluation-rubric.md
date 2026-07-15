# Quran Recitation Evaluation Rubric & Methodology

This document establishes the evaluation methodology and grading rubric for teacher and AI alignment validation, satisfying the requirements of Phase 1 Task 1.4.

---

## 1. Labeled Holdout Dataset Specification

- **Name**: `fatihah-juz-amma-reviewed-v1`
- **Size**: 500 recitation sessions (audio-transcript pairs)
- **Curation**: Hand-selected and verified by lead teachers across multiple dialects/accents.
- **Demographic Slices**:
  - **Arabic (Native)**: 200 samples. Evaluates optimal baseline performance.
  - **Kurdish Sorani**: 150 samples. Evaluates performance on regional pilot demographic.
  - **English (Non-Native)**: 150 samples. Evaluates performance under strong accents.

---

## 2. Rubric for Blinded Teacher Grading

To calibrate the AI models, human teachers perform blinded evaluations using the following scoring rubric:

### A. Word Alignment & Completeness
- **Match (Score 3)**: Every word in the ayah is correctly recognized and aligned in the correct sequence.
- **Needs Review (Score 2)**: The learner made a minor pronunciation mistake (e.g. vowel correction), but the word was successfully aligned.
- **Missed (Score 1)**: The learner skipped the word entirely or misread it completely.

### B. Tajweed Accuracy (Rule-by-Rule)
- **Approved (Score 1)**: The model correctly identified a valid tajweed site (e.g. qalqalah, madd tabii) and its status is verified.
- **Reject (Score 0)**: The model missed a tajweed site or incorrectly flagged a rule.

---

## 3. Evaluation Math & Statistical Boundary Gates

- **Word Alignment F1**:
  $$\text{Precision} = \frac{\text{TP}}{\text{TP} + \text{FP}}, \quad \text{Recall} = \frac{\text{TP}}{\text{TP} + \text{FN}}$$
  $$\text{F1} = 2 \cdot \frac{\text{Precision} \cdot \text{Recall}}{\text{Precision} + \text{Recall}} \ge 0.90$$
- **Tajweed F1**: Calculated on rule detections, gate boundary $\ge 0.82$.
- **False Positive Rate**: Target boundary $\le 0.08$.
- **Teacher Agreement Rate**: Target boundary $\ge 0.90$.
- **Bootstrapping Confidence Interval**: Resample dataset 1,000 times to calculate 95% CI.

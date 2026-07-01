# Web Speech Consent Impact Map

## Symbols

- `AuthenticatedApp.toggleAsrRecording`
  - Affected behavior: fallback order after local Quran ASR cannot start.
  - Callers: learner practice record button.

- `ConsentPanel`
  - Affected behavior: learner can explicitly opt into external/browser speech processing.
  - Callers: learner home consent panel.

- `startAsr`
  - Affected behavior: unchanged; still starts browser Web Speech when called.
  - Contract: App decides whether privacy consent permits calling it.

- `startLocalAudioRecording`
  - Affected behavior: unchanged; used as privacy-safe fallback when automatic ASR is unavailable or not consented.

## Tests

- New helper tests prove both explicit consent and guardian approval are required for external/browser speech fallback.
- Existing App smoke tests keep the learner and internal command paths rendering.

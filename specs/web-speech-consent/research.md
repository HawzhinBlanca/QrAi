# Web Speech Consent Research

## Current Behavior

- `apps/web/src/App.tsx` starts the local ASR service first through `startServerAsr`.
- If local ASR cannot start, the app falls back to browser Web Speech through `startAsr`.
- The local ASR service runs on the user's configured ASR service and is treated as the default local Quran-recitation path.
- Browser Web Speech may be backed by browser/vendor speech processing, so it is external-ASR-like from the learner privacy boundary.
- The current consent panel exposes retention, anonymized learning, and guardian approval, but no explicit external-ASR processing opt-in.

## Risk

The learner can receive automatic transcript/alignment feedback through browser Web Speech without explicitly consenting to external speech processing. That violates the project privacy rule that external ASR must be consent-gated.

## Target Behavior

- Local Quran ASR remains available by default.
- Browser Web Speech fallback runs only when `externalAsrProcessing` and `guardianApproved` are both true.
- If local ASR is unavailable and external fallback consent is missing, the app records locally for playback/teacher review instead of sending speech to a browser speech service.
- The learner can opt in from the consent panel with clear wording.

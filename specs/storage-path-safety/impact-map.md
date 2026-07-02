# Storage Path Safety Impact Map

## Files

- `services/ml-inference/server.mjs`
  - Adds path-segment validation for local audio storage, privacy export, and privacy delete.
  - Affects `storeAudioChunk`, `storeAudioObject`, `listAudioObjects`, and `deleteAudioObjects`.

- `scripts/smoke-privacy.mjs`
  - Adds an adversarial retained-audio request that must return 400.

- `services/ml-inference/README.md`
  - Documents the safe segment constraint for local retained-audio storage IDs.

## Affected Callers

- Browser/API smoke use hyphenated IDs and should keep working.
- Privacy smoke covers both normal retained IDs and rejected traversal IDs.

## Proof

- Red target: `/v1/audio-chunks` accepts a learner ID containing `../`.
- Green target: the same request returns HTTP 400 and valid retained audio still exports/deletes cleanly.

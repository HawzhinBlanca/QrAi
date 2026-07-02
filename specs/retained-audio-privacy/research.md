# Retained Audio Privacy Research

## Current Behavior

- `services/ml-inference/server.mjs` stores retained audio as `<chunkId>.bin`.
- The same endpoint always writes `<chunkId>.meta.json` beside the audio object. The metadata includes tenant, learner, session, chunk, timing, size, and object key details.
- `listAudioObjects()` only lists `.bin` files.
- `deleteAudioObjects()` only deletes `.bin` files and then tries to remove the learner directory. If `.meta.json` remains, the directory stays in place with learner/session identifiers.
- `scripts/smoke-privacy.mjs` only exercises discard-mode predictions, so it expects zero audio object keys and does not prove retained object deletion.

## Risk

Privacy delete can report completion while local retained-audio metadata remains on disk for the learner. That is a right-to-erasure gap in the current local object-storage boundary and weakens the proof checklist's audio deletion claim.

## Target Behavior

- Privacy export reports retained audio blobs and retained metadata sidecars for the learner.
- Privacy delete removes both audio blobs and metadata sidecars for the learner.
- Privacy delete does not remove other tenants or other learners.
- `pnpm smoke:privacy` proves the retained-audio path by storing an audio chunk, exporting it, deleting it, and re-exporting an empty object list.

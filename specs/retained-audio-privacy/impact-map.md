# Retained Audio Privacy Impact Map

## Files

- `services/ml-inference/server.mjs`
  - `listAudioObjects`, `deleteAudioObjects`, `exportPrivacy`, and `deletePrivacy` own the local object-storage privacy surface.
  - `storeAudioChunk` is the producer of both `.bin` and `.meta.json` files.

- `scripts/smoke-privacy.mjs`
  - Adds a retained-audio red/green proof around `/v1/audio-chunks`, `/v1/privacy/export`, and `/v1/privacy/delete`.

- `docs/proof/10-10-proof-checklist.md`
  - Clarifies that local audio deletion/export smoke now covers retained audio objects and metadata sidecars, while production object storage remains a separate gate.

## Affected Callers

- `scripts/smoke-privacy.mjs` calls ML privacy export/delete.
- `scripts/smoke-all.mjs` runs `pnpm smoke:privacy`, so the aggregate smoke proof inherits this check.

## Proof

- Red target: retained audio storage leaves `.meta.json` after privacy delete.
- Green target: retained audio export lists both audio and metadata objects, delete reports both, and post-delete export returns empty lists.

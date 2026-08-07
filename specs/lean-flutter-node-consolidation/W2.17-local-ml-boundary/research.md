# W2.17 research — local ML, audio, and privacy boundary

**Scope:** BE-1, BE-4, BE-6; research only. JavaScript symbols/references were mapped with
Serena. Rust LSP was unavailable, so the two bounded gateway/platform call sites were read directly.
## Current implementation

- `services/ml-inference/server.mjs` is a 2,350-line process mixing HTTP/key admission, canonical
  loading, attribution, alignment, Tajweed, ASR, audio, audit, privacy, timers, and lifecycle.
- Its route-only functions include `transcribeSession`, `predictAlignment`, `predictTajweed`,
  `storeAudioChunk`, `exportPrivacy`, `deletePrivacy`, and `sweepExpiredAudio`; tests import several
  of these directly, so the HTTP file is also an accidental library boundary.
- `server/src/storage/audio-object-store.mjs` is already the one async filesystem/S3 interface.
  Production Node privacy and teacher playback use the injected store directly; ML HTTP is only a
  no-store migration/parity fallback in `privacy.mjs` and `review.mjs`.
- `server/src/jobs/workflows.mjs::createWorkflowHandlers` is shared by API and worker composition.
  `prepareSessionFinalization` still calls ML `/v1/session-transcript` then
  `/v1/alignments:predict`; `prepareSessionEvaluation` still calls
  `/v1/tajweed-findings:predict`. Their fenced database commit paths are already reusable.
- `server/src/jobs/inline.mjs::runInlineJob` claims and executes jobs inside the API process to keep
  synchronous response bodies. Importing CPU-heavy local inference into that handler would violate
  ADR-0050; the API must become enqueue-and-bounded-wait while a worker owns execution.
- `server/src/worker.mjs::main` already owns restricted-DB job execution and the object store, but its
  workflow context still requires `ML_INFERENCE_URL` and `ML_API_KEY`.
- The Rust gateway first sends bytes to key-gated ML `POST /v1/audio-chunks`, then separately sends
  realtime-ticket metadata to platform `POST /v1/audio-chunks`. The equal paths have different trust
  and payload contracts; the compatibility ingress cannot be registered as the public Node route.

## Integration and deployment consumers

- Rust platform-api still calls ML transcript/alignment, Tajweed, privacy-delete, and audio-read
  endpoints while it remains the Compose traffic target. Rust gateway calls ML audio ingestion.
- Compose builds a separate ML image; Node API/worker point at it, the worker health-depends on it,
  and Web/release manifest/image/SBOM/evidence lists treat it as a deployable service.
- ML unit/contract tests, real-audio finalization, privacy/audio journeys, gateway retention/index
  failure tests, smoke scripts, and load tests either import or spawn the old server directly.
- `server/Dockerfile` copies two ML implementation files and one Quran provenance file; the ML image
  separately copies the server deadline/store. This circular packaging is the concrete duplicate
  boundary W2.17 must remove.

## Required boundary

- One package-owned inference library must separate pure canonical algorithms, ASR client/orchestration,
  retained-audio lifecycle, audit, and HTTP compatibility composition. Canonical bytes stay immutable;
  no `.normalize()` or literal Arabic combining-mark regex may enter the move.
- The durable worker directly invokes typed local operations with one parent `AbortSignal`; ASR remains
  the isolated evaluated Python worker. The API only enqueues and waits within its request deadline.
- A temporary server-package compatibility process may preserve every endpoint still consumed by Rust
  during W2.18. Only key-gated audio ingestion is long-lived until W3 gateway cutover;
  narrowing earlier would break the current Rust traffic target.
- Retention sweep ownership must be single-process, cancellation-aware, non-overlapping, and must keep
  training-opt-in retention semantics. File audit must not become a second authority beside DB audit.
## Highest risks and proof obligations

- Prevent duplicate writers/algorithms, API-event-loop inference, unfenced job completion after abort,
  raw audio/transcripts/secrets in jobs/logs, and a path collision between private ingest and indexing.
- Preserve attribution/source/review gates, exact transcript/alignment refusal semantics, create-only
  object conflict behavior, privacy manifests, missing-chunk accounting, and fixture-mode labels.
- Relocate tests before deleting the old tree; prove worker queue/cancellation, API wait/disconnect,
  finalize/Tajweed/privacy/audio E2E, Rust compatibility auth, retention, production image, release
  inventory, and the canonical live-Postgres gate. W2.18—not this slice—authorizes traffic cutover.

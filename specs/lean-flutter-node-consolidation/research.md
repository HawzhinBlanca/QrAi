# Research — lean Flutter + Node consolidation

**Status:** program research complete; W1.10 acoustic delta grounded; implementation follows the approved plan.

## Decision

- Do **not** start a new repository or rewrite from zero. Consolidate this repository in place.
- The desired destination is one Flutter client and one Node codebase, with Postgres and object storage.
- Keep Rust and React only as migration oracles until their proven behavior has moved; deleting them now breaks the core journey.
- Keep Python ASR isolated until an evaluated ONNX/on-device replacement exists; runtime ideology is not an accuracy proof.

## Grounded current state

- `package.json`, `pnpm-workspace.yaml`: root dev/build/test still target React and Rust; Node API and Flutter are not the default product graph.
- `docker-compose.yml`: deploys React + Rust gateway/API + Node ML + Python ASR; it has no Node API service.
- `scripts/release-images.mjs/SERVICES`: release artifacts cover the old five-image topology, not `services/node-api` or Flutter.
- `services/node-api/server.mjs::{PORTABLE,buildServer}`: 37 local operations, an empty default port list, and a mandatory Rust upstream leave Node as a strangler.
- The Rust router has 42 pairs, including two audio routes hidden by the old comment-sensitive inventory; the former 40/40 checks were false-green.
- Rust-only operations are register, login, audio indexing, session finalization, and learner session findings.
- `apps/flutter/lib/src/practice/practice_screen.dart`: the flagship flow still calls Rust-only finalization and learner findings.
- `apps/flutter/lib/main.dart/HomeShell`: real reader, practice, progress, privacy, and teacher-review tabs; UI locale is English only.
- Flutter lacks enrollment, delayed feedback, progress writes, guided practice, and device proof; React still owns the richer deployed roles while Expo is an unbuilt predecessor.
- The Rust gateway uniquely owns realtime safety and indexing; Compose omits its `PLATFORM_API_URL`, disabling standard-stack indexing.
- Compose initializes SQL through `0021`; CI applies through `0027`; no upgrade migration runner exists.
- Node lacks Rust-equivalent maintenance mode, rate limiting, privileged-DB boot refusal, graceful drain, and bounded proxy fetches.
- ML is load-bearing but discards real ASR spans; the isolated acoustic path runs generic Whisper `base`, and text-rule Tajweed carries no measured confidence.
- `services/tajweed-neural` and `services/agents` are not in the deployed topology and are experimental/operator-only.

## Integration and deletion order

1. Repair route/contract/migration truth before trusting any green cutover result.
2. Make Node a real package/image and port or deliberately remove all five Rust-only operations.
3. Add service-level security/lifecycle parity, then port realtime into the Node codebase with the Rust gateway as oracle.
4. Complete the minimum Flutter product: Kurdish/Arabic, guided practice, progress writes, delayed feedback, teacher audio, enrollment, device proof.
5. Route canary traffic to Node/Flutter, rehearse rollback, and obtain security/operations sign-off.
6. Remove Expo first; remove React and Rust only after their replacement gates pass; retire disconnected experiments.
7. Reduce active docs/specs after cutover, preserving decisions and test evidence in history.

## Main risks

- A green test suite currently does not prove route completeness.
- A flag-day deletion loses trusted server-derived evidence, learner review gating, or audio findability.
- Current green tests use mocks/fixtures that hide the real no-span/no-visible-feedback integration failure.
- Rewriting canonical Quran/privacy/RLS logic in a new project recreates already-fixed correctness failures.
- Merging CPU-heavy inference onto the API event loop would make the tree smaller and reliability worse; use a worker entrypoint in the same Node package.
## W1.4–W1.6 grounded delta
- W1.4 now proves independent liveness, loaded-model readiness, exact expected digest, bounded probe, retry, and replacement recovery in the production image; it does not claim recognition accuracy.
- No tracked audio or approved held-out Kurdish-L1 corpus exists. The draft protocol in `specs/kurdish-asr-evaluation/spec.md` still requires owner, scholar, legal/privacy, consent, and minor-safeguard approval before collection or scoring.
- Compose runs generic OpenAI Whisper `base`; the Python default names a mutable Hugging Face alias and does not pass an immutable revision. Hugging Face documents full commit revisions for reproducible downloads: <https://huggingface.co/docs/huggingface_hub/main/guides/download>.
- Tarteel's Quran-tuned base has immutable commit `e3f4a5f3f5336a1f0e43a2c2bdae62a680c53a8c`, but its card reports no training/evaluation dataset and insufficient limitations, so its published WER is not product evidence: <https://huggingface.co/tarteel-ai/whisper-base-ar-quran>.
- IqraEval 2025 is the strongest public Quran pronunciation benchmark found, but its 98-verse test set is 18 Arabic-L1 adults with elicited errors; its best system precision is 0.3713 and it explicitly lacks children and dialect diversity: <https://aclanthology.org/2025.arabicnlp-sharedtasks.61/>.
- The existing metric library is reusable, but the release contract and seeded `fatihah-juz-amma-smoke-v1` row are not candidate/dataset/evaluator-bound evidence. W1.5 must reject aliases and fixtures, prepare exact candidates, and record `no-winner` until approved real-audio evidence exists; W1.12 later owns reproducible signed release evidence.
- OpenAI Whisper already returns measured `word/start/end/probability`, but `recognizedWordsFrom` strips everything except text; Rust finalization consequently receives no spans and can report finalized after persisting zero alignments.
- A timestamp-less ASR result must be force-aligned against its recognized transcript, never the canonical passage; otherwise an omitted canonical word acquires fabricated audio evidence.
- `/v1/transcribe` and `/v1/force-align` correctly cap a worker request at 120 seconds, while `transcribeSession` currently concatenates the whole session into one request and turns a longer valid session into an upstream failure.
- Bounded context windows with non-overlapping commit intervals can preserve absolute offsets and repeated words: decode with left/right context, then retain only tokens whose midpoint belongs to that window's core.
- Missing audio, inconsistent sample rates/timing, unavailable force alignment, malformed/non-monotonic spans, or an unspanned token must produce an explicit non-finalized reason and no evidence claim.
- The declared W1.6 integration fixture is Wikimedia Commons `AlFātihatulKitāb.ogg`, CC0, 92.72 seconds, SHA-1 `671b6e324988d3752318d2e8be1fb9cc7db30e58`; it is test audio, never benchmark or accuracy evidence.
- Serena is unavailable for this pass; repository-wide exact-name/import `rg` plus direct caller inspection found the W1.6/W1.7 consumers recorded in `impact-map.md`.

## W1.7 grounded result

- `alignWords` can preserve measured token spans without changing its transitional string callers;
  misses are explicitly spanless and extras never become canonical persistence candidates.
- `predictAlignment` must distinguish useful practice output from finalizable evidence. A bare
  transcript is therefore non-finalizable, and any malformed measured token refuses the whole
  evidence result instead of mixing valid and invalid claims.
- `recognizedTokens` cannot be a public request field: both Rust and Node proxies reject it before
  forwarding, while Rust finalization obtains it only from the server-to-server transcript route.
- Atomic replacement is required because deleting earlier rows before discovering one invalid ML
  claim would convert a producer defect into learner-data loss. The live Postgres test proves the
  transaction preserves the old alignment set on any invalid claimed row.
- The checksum-pinned CC0 PCM E2E stores 15 measured matched/misread rows and stores neither one
  omitted canonical word nor one recognized extra. This is integration evidence, not recognition
  evaluation.
- Database alignment rows still preserve only the session-level compatibility `model_version`; the
  ASR/forced-aligner/Quran-aligner component records, transcript source, artifact digests, and
  dataset identity do not round-trip. That exact loss is the W1.8 boundary.

## W1.8 grounded delta

- `transcribeSession` calls validated ASR and, when necessary, forced-aligner producers, but returns
  neither producer attribution. Multi-window output therefore cannot prove that every window used
  the same component artifact, and the caller cannot distinguish ASR-timed from force-aligned spans.
- `predictAlignment` receives trusted tokens without their transcript attribution, so its composed
  response contains only `quran-aligner`. The ASR and forced-aligner identities disappear before
  persistence even has a chance to store them.
- `alignment_runs` is already tenant-RLS protected and has session, model, dataset, evidence, consent,
  latency, and audit columns, but finalization never inserts it. `word_alignments` has no link to a
  run, so joining by session alone could attach stale server provenance to later client-reported
  replacement rows.
- `recitation_sessions.model_version_id` still selects the sole historical alignment row
  `model-v0.3`, while the real producer's compatibility identity is
  `quran-constrained-levenshtein@1`. Silently storing the session label would violate QA-6; new
  sessions need an explicit runtime-selected registry row, and legacy disagreement must refuse.
- The existing staff-only `GET /v1/recitation-sessions/{id}/alignments` is the narrow restricted
  readback path. Adding nullable run provenance to each returned row preserves the array contract and
  makes legacy/client rows honestly return no model-attribution object rather than a default.
- A nullable composite `alignment_run_id` on `word_alignments` is the minimum unambiguous link. The
  FK must include `tenant_id`, and new `server-derived` writes must require the link; historical rows
  remain readable through a `NOT VALID` constraint rather than receiving invented provenance.
- Provenance composition must be deterministic and fail closed: repeated window components must be
  byte-equivalent, forced-aligner attribution may augment ASR, and Quran alignment must contain the
  exact transcript component records plus its own exact component. Component conflict, missing
  attribution, malformed digest, legacy-label mismatch, or session/producer mismatch finalizes
  nothing.
- The current real alignment envelope labels its top-level dataset as the smoke fixture even on the
  non-fixture path. Real predictions must instead use the Quran-aligner component's canonical corpus
  identity; the declared golden mode alone may retain the fixture dataset label.

### W1.8 implemented result

- Migration 0029 selects `quran-constrained-levenshtein@1` for new sessions without rewriting
  historical session identity, and links new server-derived words to one same-tenant/same-session
  run. Historical unlinked rows remain explicit through a NOT VALID constraint.
- The real-audio finalizer proof stores 15 words under one run and compares the actual producer
  component JSON, dataset, evidence, latency, source, consent snapshot, and compatibility label with
  both Postgres and staff readback. Learner and foreign-tenant reads are refused/empty.
- The Node finalizer is still absent and remains W2.6. Rust/Node public injection refusal and staff
  readback are parity-covered now; the finalize-only mismatch test is explicitly deferred in the
  coverage ledger.

## W1.9 grounded delta

- `tajweed.js::{analyzeWord,analyzeAyah}` reads only canonical Uthmani text. It already replaced
  invented rule-specific decimals with `confidence: 0`, but still returns performance-shaped
  objects named findings with `severity`, `confidence`, and `reviewStatus` added by
  `predictTajweed`. Zero is a numeric placeholder, not the absence of learner-performance
  confidence required by QA-5.
- `predictTajweed` puts those canonical rule occurrences in `findings`; the golden-fixture branch
  puts copied 0.84/0.85 values in the same array. Neither branch listens to the learner, yet both
  cross the learner-performance contract and persistence boundary.
- Rust and Node persist `result.findings` in session-owned `tajweed_findings`, hard-code
  `analysis_basis='canonical-text'`, and place them in the teacher performance-review queue. A
  teacher can accept one and the shared gate does not inspect analysis basis, so an approved text
  rule can still become a claim that this learner made an error.
- Migration 0025 records `canonical-text | acoustic`, while the component contract and approved
  consolidation spec use `text-rule | acoustic`. `tajweed_findings.confidence` is non-null, forcing
  a false number even when no performance score exists.
- Strict OpenAPI, TypeScript, Dart, and web models require numeric confidence on every Tajweed
  item. Flutter therefore cannot represent the honest state and its practice flow parses only the
  `findings` array.
- The lean boundary is one response with two disjoint arrays: deterministic canonical instruction
  is an `annotations[]` item labeled `analysisBasis='text-rule'` and `instructional=true`, with no
  confidence, severity, or review status; `findings[]` is reserved for span-linked acoustic learner
  judgments and is empty until W1.10. Proxies reject cross-contaminated shapes rather than relabel
  them.
- Instructional annotations are deterministic canonical metadata and do not need a new table.
  Historical text-rule rows remain auditable but lose their placeholder confidence and cannot enter
  performance review or learner feedback. New `tajweed_findings` writes are acoustic-only.

## W1.10 grounded delta

- No acoustic learner-error producer reaches the product. Python `/v1/analyze-tajweed` and the
  separate `services/tajweed-neural` endpoint have zero production callers.
- The Python duration/F0/energy/centroid path detects signal or rule presence, not a deviation from
  a reference, and maps handcrafted formulas to confidence. It cannot author learner findings.
- `tajweed-neural` is stale (`obadx/muaalem-model-v3`), whole-audio, unreferenced, uncalibrated, and
  has no word mapping. Keeping it as another service would preserve the exact disconnected shape
  this consolidation is removing.
- The real integration path already exists: Flutter streams PCM chunks; `ml-inference` owns the
  complete timeline; Rust finalization persists server-derived word spans. Tajweed prediction must
  reuse those bytes and spans, not accept client audio/transcript/timing.
- Rust/Node ML proxies currently overwrite consent but do not forward the server-owned learner id,
  stored Quran reference, or server-derived alignments. They must reject those fields from callers,
  then inject the database values for acoustic analysis.
- The best complete official reference-aware candidate found is `obadx/muaalem-model-v3_2` at Hub
  revision `01a1ef9fbe40d144ef845101e89ff924aed3fef5`, with safetensors SHA-256
  `6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41` (2,423,124,012 bytes).
- The newer official 2026 mini/W2V2/Whisper/streaming repositories contain tokenizers but, at their
  observed revisions, no model config or weights; recency does not make them runnable candidates.
- Muaalem v3.2 consumes 16 kHz audio plus a reference QPS sequence and predicts phonemes and ten
  sifat heads. Its package supports reference alignment but emits no audio timestamps; bounded
  context windows must inherit existing word spans and commit only core-word observations.
- Exact-image inference exposed an upstream decoder defect at the pinned implementation commit:
  the sifat length-mismatch branch assigns aligned class ids to `new_probs`, so its public `prob`
  field can equal `2.0`. The adapter may retain the categorical sifat label/index as a shadow
  observation, but must withhold every sifat numeric score as
  `withheld-upstream-decoder-bug`. Phoneme softmax values remain separately range-validated.
- Upstream explicitly says its CTC softmax values are uncalibrated. W1.10 may emit internal shadow
  observations only; `findings[]`, confidence, persistence, review, and learner display stay empty
  until W1.11 produces an approved calibrator and threshold evidence.
- Use a versioned checksum-bound QPS derivative of this repo's canonical word ids. Do not read the
  dependency's bundled Tanzil corpus at runtime, mutate canonical bytes, or call text normalization.
- Code/model metadata say MIT, while `quran-transcript` bundles CC BY 3.0 Tanzil data and the v3.2
  model card omits substantive training, risk, limitation, and evaluation details. Independent
  model/data licence review is required before an artifact ships.
- No adjudicated Kurdish-L1 correct/error fixture exists. A declared altered-audio integration
  vector can prove span/refusal plumbing, but cannot be presented as model accuracy or release
  evidence; W1.12 and human-approved held-out evidence remain mandatory.

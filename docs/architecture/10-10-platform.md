# Quran AI 10/10 Platform Architecture

## Current Implemented Slice

- `apps/web`: React/Vite platform command app — learner practice flow (record → real ASR
  transcription → alignment/tajweed feedback) and the internal ops console (agent runs, scholar
  queue, live recitation streaming, benchmark/eval view).
- `apps/mobile`: Expo/React Native learner app (login, surah picker, consent-gated recording,
  ASR + alignment feedback via the platform API). Not a pnpm workspace member; its pure-logic
  helpers (`lib/session.ts`) have their own `node --test` suite, gated in
  `.github/workflows/mobile.yml`.
- `packages/contracts`: permanent API/contract boundary. It owns the OpenAPI 3.1 document, the
  mechanically checked 42-operation baseline/target route manifest, shared TypeScript contracts
  for platform and canonical Quran records, proof gates, checksum verification, retention
  decisions, and the learner-facing AI gate (`canShowLearnerFacingAiOutput`). The four inference
  proxy responses are bound to strict producer-owned schemas; no operation is `x-unvalidated`.
  The model-evaluation boundary has one strict signed-bundle schema and an operator-owned Ed25519
  public-key policy. `scripts/model-evidence-verifier.mjs` canonicalizes the evidence object with
  RFC 8785, checks its exact SHA-256 and detached signature, and keeps signer trust outside the
  bundle. The committed production policy starts empty; fixtures and ephemeral test keys cannot
  become release authority.
  Inference responses use a closed component-attribution contract: each active ASR, forced-aligner,
  Quran-aligner, acoustic-scorer, or calibrator record identifies its implementation, exact
  artifact digest, dataset, and analysis basis. The compatibility `modelVersion` is derived from
  the primary component and is not accepted as client authority.
- `packages/quran-data`: canonical Al-Fatihah seed (checksum-verified via `@quran-ai/contracts`),
  source manifests, and a server-only full 114-surah bundle acquired from Al Quran Cloud edition
  `quran-uthmani` (`fetch-full-quran.mjs` + `scripts/seed-full-quran-to-db.sh`) seeded into
  `canonical_ayahs`/`canonical_words`. Its reviewed, append-only provenance v2 record pins the
  direct provider, edition, terms, counts, legacy checksum, and independently length-delimited
  ayah/word-token SHA-256 values; the exact upstream artifact remains unresolved. The production
  seed validates this record before emitting SQL.
- `services/platform-api`: Rust/Axum + SQLx/Postgres tenant-scoped API — auth (register/login,
  bcrypt, JWT), recitation sessions, learner progress (real SM-2 spaced repetition), privacy
  export/delete (with ML-service audio erasure), teacher reviews, scholar approvals, agent-run
  recording, eval-run lookup, audit events, and realtime ticket issuance. Tenant isolation is
  enforced by Postgres RLS on every tenant-owned table. Migration 0018 adds a structured optional
  `agent_runs.learner_id`; the agent-run API can persist it and privacy export/deletion use it for
  learner-linked runs. Cohort-level or legacy runs without that structured key are not attributed
  by free-text inference. Finalized server-derived words share one `alignment_runs` record that
  stores the exact component attribution, dataset, evidence, consent snapshot, latency, source, and
  audit reference. A composite run/tenant/session foreign key prevents stale or cross-tenant
  provenance attachment; staff read it through the existing tenant-scoped alignment endpoint.
  See `docs/DATA_INVENTORY.md` §1.
- `services/realtime-gateway`: Rust/Tokio/Axum realtime gateway — ticket-authenticated (HMAC,
  single-use, tenant-bound) WebSocket audio ingress, origin-checked (CSWSH-resistant), bounded
  per-session channel with backpressure, forwards chunks to ml-inference, then records the stored
  object through platform-api before teacher playback can discover it. Metrics distinguish forward
  loss, attempted index failure, disabled indexing, and the aggregate stored-unindexed count.
- `services/ml-inference`: Node — real Quran-constrained word alignment (Needleman-Wunsch global
  alignment over a comparison-only Arabic projection, `alignment.js`) and a rule-based tajweed engine
  (`tajweed.js`: madd, ghunnah, qalqalah, idgham, iqlab, ikhfa, tafkhim). Consent-gated proxying to
  asr-inference for external ASR. Alignment responses hash the exact aligner source and preserve
  validated upstream ASR attribution; public proxies reject missing or contradictory provenance.
  Stored PCM transcription preserves producer word spans as absolute millisecond tokens. Sessions
  longer than one worker request use 90-second cores plus bounded context; midpoint ownership avoids
  text-based deduplication deleting legitimate repeated Quran words. A timestamp-less transcript is
  force-aligned only against its recognized words. Missing chunks, mixed audio formats, unavailable
  force alignment, or malformed spans return an explicit non-finalized result. Quran-constrained
  alignment carries a measured source span only from the recognized token it matched; omissions
  receive null spans. Public proxies reject caller-authored measured tokens. Transitional
  finalization persists only canonical matches/misreads and rolls the whole replacement back if any
  claimed output span or canonical word is invalid. Transcript attribution is composed across
  windows and forwarded only inside the private finalizer chain; the Quran result must preserve
  every upstream component exactly before its tenant-bound run can be stored.
  Tajweed rule detection is explicitly instructional: deterministic canonical rules and declared
  fixture rules return in `annotations[]` with `analysisBasis=text-rule` and no confidence,
  severity, or review state. `findings[]` is reserved for real acoustic learner-performance
  evidence and is empty until a calibrated, evaluated, approved producer exists. For retained audio
  with server-derived measured spans, it may invoke the private Muaalem shadow observer; only
  status/count/attribution enters audit metadata, never raw probabilities or learner findings.
  Evaluation is not an online inference responsibility: the former ML `POST /v1/eval-runs` metric
  copier is removed. The offline row-authoritative evaluator plus detached-signature verifier is the
  sole evidence-production path; smoke can exercise it only with declared fixture eligibility and an
  ephemeral test-only key.
- `services/asr-inference`: Python/FastAPI — real acoustic ASR via `openai-whisper`
  (`ASR_MODEL` configurable; the current deployment runs generic Whisper `base`, not the
  Quran-tuned `tarteel-ai/whisper-base-ar-quran` default in code — see the `ASR_MODEL` comment in
  `docker-compose.yml` for why). The image also carries one candidate registry: runtime configuration
  must match its model, revision, and artifact digest before allocation. Hugging Face candidates
  require a full commit and a byte-verified weight file; aliases fail. The registry intentionally
  records `blocked-no-eligible-benchmark`, so generic `base` is an operational placeholder rather
  than an accuracy winner. API-key gated, rate-limited. ASR, forced alignment, and acoustic
  scoring author separate digest-bound component records; an undeclared external checkpoint or
  unavailable calibrator cannot be presented as active. Process-only `/health` binds before model
  loading; `/ready` and ASR route admission share one cached state that requires the configured
  artifact digest and a bounded deterministic inference probe. One background worker retries
  transient failure without overlapping model/probe work; Compose depends on `/ready`.
  An optional, non-Compose `acoustic-candidate` image target pins Muaalem v3.2, its implementation,
  QPS implementation/profile, and every model file. It exposes only a private 16 kHz/15-second
  reference-aware shadow observation route through a restartable child. The normal image omits the
  2.4 GB artifact. Phoneme softmax values are uncalibrated; sifat scores are withheld because the
  pinned upstream mismatch decoder can substitute class ids for probabilities. The separate
  calibrator loader requires exact calibrator bytes plus scorer-artifact, dataset-manifest, and
  evaluation-evidence digest bindings. Its committed registry has no active entry, and the
  shadow-only candidate refuses activation. Neither raw score can enter `findings[]`. The
  superseded standalone experiment has been removed from the repository.
- `services/agents`: Node — supervised agent workflows (Tajweed Explainer, Mistake Pattern
  Summarizer, Practice Plan Recommender), each producing a sourced, reviewer-gated `agent_run`.
  No agent output reaches a learner without clearing `canShowLearnerFacingAiOutput`.
- `services/shared-ticket`: Rust — HMAC realtime-ticket issuance/validation shared by
  `platform-api` (issuer) and `realtime-gateway` (validator), so the signing logic lives in one
  place.
- `server` / Compose `node-api`: the production Node package and internal shadow image. The image
  is built from the frozen server workspace production graph on digest-pinned Node 22.13.1, runs as
  the non-root `node` user, publishes no host port, and uses a native bounded `/ready` healthcheck.
  Only `/health` and `/ready` are local in this wave; every other operation still has the retained
  Rust `platform-api` compatibility upstream. Web and realtime continue to address Rust, so this is
  deployment/observation proof rather than a traffic cutover. The runtime image contains only the
  five declared production libraries, legacy Node route modules, and the exact alignment,
  attribution, and immutable provenance files those modules import—no TypeScript, tests, Web,
  contracts package, Rust service, or broad Quran source tree.
- `infra/migrations`: immutable, manifest-checksummed Postgres schema history, including tenant RLS,
  learner-progress isolation, superuser-only bypass protection, uniqueness guarantees, and the
  structured agent-run learner key used by privacy export/delete. `server/scripts/migrate.mjs` is
  the only migration boundary: advisory-locked, transaction-per-file, and database-ledger checked.
  Full Quran seed generation is owned by `packages/quran-data`; restricted runtime-role rotation is
  a separate provisioner under `infra/provision`.
  Migration 0030 retains historical deterministic Tajweed rows for audit as `text-rule` with null
  confidence, while database constraints and review/read queries reserve learner-performance state
  for non-null-confidence `acoustic` rows.
  Migration 0031 extends the existing RLS-protected `eval_runs` authority in place: historical
  aggregates are explicitly fixture-only/non-release, while computed evidence is all-or-nothing,
  digest-bound, signed, and immutable. Nullable historical finding provenance becomes an exact
  same-tenant composite reference whenever supplied; no second evaluation table is introduced.
  The staff EvalRun read model exposes this complete authority state in one strict shape. Rust and
  Node preserve identical field order and JSONB ordering; React consumes the shared TypeScript type
  and cannot paint fixture/research rows as passing release benchmarks.
  Migration 0032 demotes the remaining historical `eval-passed` aggregate claim because the
  production signer policy is empty. The release checker considers every tenant-visible row,
  verifies exact signed bytes, and requires one unique release identity; creation order cannot hide
  evidence, while a conflicting or invalid release-labelled row fails closed.
  Migration 0033 makes every new acoustic finding reference one exact same-tenant acoustic
  evaluation chain. Stored finding reads join the alignment span, retained audio evidence, model,
  dataset, calibrator, evaluation and audit identities. One shared cross-runtime corpus requires
  every field plus human review and calibrated confidence. Historical, stale, fixture-bound,
  unverified, discarded-audio and uncalibrated rows remain reviewable but learner-withheld.
- `server/scripts/repair-audio-index.mjs`: dry-run-by-default reconciliation for retained filesystem
  audio. Storage metadata only nominates a candidate; a tenant-scoped session row must independently
  confirm tenant and learner ownership before an idempotent index insert. The Compose operations
  profile mounts audio read-only and connects as `quran_ai_app`.
- `scripts/verify.sh`: canonical local/CI gate — Rust fmt/clippy, TS typecheck, TS/Rust/Node
  tests, live Postgres integration tests when reachable, production build, and web bundle secret
  scan.
- `scripts/smoke-*.mjs`: running-stack proof for SQL/RLS, API, gateway, ML, privacy, browser, and
  trace-linked aggregate smoke.

## Architecture Direction

The approved consolidation target keeps this repository and migrates it in place to one Flutter
client plus one modular Node codebase with separate API, realtime, and worker processes. The current
Rust/React/Expo services remain compatibility oracles until their canary and rollback gates pass;
they are not deleted by directory cleanup. `packages/contracts/route-manifest.json` records the
boundary: 42 current operations, four explicit retirements, 38 retained baseline operations, and
four separately named device-session/learner-history additions. Counts are derived from those sets.

### Target Node backend boundary (ADR-0050)

`server/package.json` becomes the single Node production dependency boundary with separate API,
realtime, and worker entrypoints. CPU-heavy inference stays off the API event loop. Production
retained audio moves to private S3-compatible storage with server-derived keys; filesystem storage
is a test/development adapter only. One monotonic request deadline propagates through Postgres,
storage, ASR, compatibility, and worker calls with `AbortSignal`, while bounded process admission
and durable Postgres credential/replay state avoid a new Redis or NATS dependency. Production
identity remains controlled device enrollment with server-derived tenant/role, rotating revocable
credentials, and provisioned staff. These are accepted target constraints, not claims that the
current strangler already implements them.

Public password register/login and both generic agent-run operations are retirement targets
(ADR-0038). They remain served only during the strangler period and cannot be removed while a
production caller remains. Login stays owner-gated off; the future native identity path is
single-use invitation exchange plus rotating/revocable device sessions.

The winning architecture is a real vertical slice first:

1. Learner app captures mic audio and chunks it locally.
2. Realtime gateway applies bounded backpressure, stores consent-covered chunks, and writes their
   durable tenant-bound index; stored-unindexed outcomes are alerted and repairable.
3. Session transcription composes bounded ASR windows into measured absolute recognized-token spans;
   incomplete audio refuses finalization rather than turning storage loss into learner mistakes.
4. Quran-constrained mapping carries those source spans to heard canonical matches/misreads; omitted
   words and extra tokens receive no persisted canonical evidence, and partial output rolls back.
5. Teacher playback resolves the index, rechecks consent and role, audits the attempt, then fetches
   bytes from storage without exposing an object credential.
6. Canonical Quran text constrains word alignment and Tajweed instruction; retained audio plus
   server-derived spans may feed private acoustic shadow evaluation.
7. Low-confidence findings go to teachers before becoming learner-facing claims.
8. Religious explanations require source references and human review status.
9. Reviewed corrections become labeled eval/training data.
10. Model releases are blocked unless benchmark and trust gates pass.

## Non-Negotiable Rules

- Arabic Quran text is canonical, checksummed, and never machine-modified.
- AI output must include source references, confidence, component implementation/artifact/dataset
  attribution, review status, evidence ID, tenant ID, and audit event ID.
- Audio retention defaults to `discard`; storage requires explicit learner consent.
- Agents are supervised tools. They may plan, explain, route, localize, and summarize, but they cannot issue unsourced religious answers.
- Institution data is tenant-scoped by default.

## Still Not Implemented

- Managed production deployment posture beyond the implemented restricted DB role/migration
  boundary: production secrets/origins, backups, complete observability, and branch-protected CI.
- Edition-level upstream attribution for Al Quran Cloud `quran-uthmani`; the provider names
  multiple upstream sources but does not publish an exact artifact mapping.
- Managed object storage for retained audio and privacy deletion beyond the current local
  filesystem boundary.
- Cross-service NATS/JetStream emission for audit/event fanout.
- OpenAI Realtime/Agents SDK integration (the agents service and ASR are custom-built, not
  built on OpenAI's SDKs — ASR uses locally-run `openai-whisper` model weights only).
- Production institution auth provider/RBAC (OIDC/OAuth or equivalent), beyond the current
  JWT/login implementation.
- Live pilot usage with real learners at scale (the pilot tenant, seed data, and teacher/scholar
  review workflows exist and are exercised by integration tests, but this has not yet been used
  by real learners in the field).
- The Quran-tuned ASR model (`tarteel-ai/whisper-base-ar-quran`) is not actually running in the
  current deployment — it requires `transformers` as a new production dependency, a decision not
  yet made (see `ASR_MODEL` in `docker-compose.yml`).

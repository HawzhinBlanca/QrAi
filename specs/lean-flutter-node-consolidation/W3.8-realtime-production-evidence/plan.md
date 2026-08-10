# W3.8 plan — production-image realtime proof

**Status:** APPROVED — implementation proceeds one test-first slice at a time
**Approved-by:** Repository owner — explicit “approved and go” on 2026-08-10
**Criteria:** RPI-1…RPI-7; parent RT-1…RT-4

## Decision

Keep one lean raw-binary wire and freeze its only supported product profile as mono signed PCM16LE,
16 kHz, 480 ms/15,360 bytes per frame. Ticket issuance returns only `[16000]`; Node accepts only the
exact frame size and preserves the 2 MiB/transport caps as hostile-input boundaries. This fixes the
current false timing/rate metadata without adding a codec envelope, negotiator, transcoder, or
second ingestion path. Rust remains the public oracle: valid-profile wire behavior must agree, while
Node's stricter refusal of invalid audio shapes is an explicit safety divergence.

Add a proof-only loopback Compose overlay and a Node operator runner that reuses the existing
release-selection authority. The runner inspects the selected and running immutable Node/Rust
images, renders and hashes topology, drives both endpoints with separately issued single-use
tickets, captures only aggregate/digested results, and writes strict owner-only evidence once.
Normal Compose continues publishing only Rust on 8081; no service, image key, package, or traffic
edge is added.

Separate development proof from completion proof. Canonical verification tests the profile,
evidence schema, command plan, mutations, refusals, and exact invocation. Docker CI performs a
short built-image smoke. W3.8 closes only after the same exact release candidate runs isolated
staging protocol/hostile/retention/fault/capacity/classroom/burst/30-minute-soak stages, all fixed
thresholds pass, remote exact-SHA checks pass, and a small repository evidence note records only
artifact hashes and validated outcomes.

## Test-first implementation sequence

1. Add red RPI-1 cases to API parity/contracts, bounded audio, and the Flutter contract: 24/48 kHz
   can no longer be advertised; only an exact 15,360-byte frame is accepted; all wrong sizes are
   acknowledged as rejected without sequence movement; text and transport behavior remain stable.
2. Add red `tests/release/realtime-image-evidence.test.mjs` cases for the seven required ordered
   stages, candidate and topology identity, fixed profiles/thresholds, exact metric accounting,
   expiry, dirty/mutable/source/fixture/skip/failure refusal, output permissions/write-once plan,
   redaction, and exact-one canonical invocation.
3. Implement the audio profile with the smallest cross-runtime compatibility surface:
   `AUDIO_LIMITS.frameBytes`, exact-length admission, Node/Rust ticket issuers returning only 16 kHz,
   response contracts/OpenAPI, and the existing Flutter contract/comment. Do not redesign the
   recorder or touch Web capture. Keep ack fixtures and ticket bytes unchanged.
4. Implement a strict evidence library plus proof runner. Reuse
   `assertReleaseDeploymentSelection`/`composeImageEnvironment`; never fork release identity logic.
   Add a proof-only loopback overlay, exact Compose command plan, safe project/port/path parsing,
   clean-SHA preflight, immutable image inspection, topology hashing, bounded health polling,
   cleanup/restoration in `finally`, and write-once mode-0600 output. No credential/audio/identity is
   serialized, logged, or hashed into a reversible artifact.
5. Implement probe stages behind testable adapters: valid Rust/Node parity; hostile tickets/frames;
   durable cross-instance replay; three retention modes and cleanup; clean and ambiguous process
   interruption, counting an unsent retained tail as client-dropped and sent/no-ack audio as
   unresolved without inventing a durable server outcome. Establish the ambiguous window by
   suppressing acknowledgement delivery to the proof client only after a real socket send, then
   SIGKILL and restore the same exact container; do not alter server acknowledgement behavior.
   Then prove Postgres outage and a second same-image fault container that first boots healthy
   through a proof-runner-owned TLS-transparent TCP pass-through to the configured production S3
   endpoint. Cut only that pass-through at runtime: the fault process must become unready, record
   an acknowledged frame as accepted loss with no object/index, and recover only after it is
   removed and the production-S3 candidate is revalidated. The pass-through is in-memory proof
   tooling, never a Compose service, deployable image, application switch, or public edge. Require
   an explicit pathless HTTPS endpoint, preserve its hostname/SNI through the fault
   container's sole `host-gateway` mapping, and bind the bounded listener only to Docker's private
   RFC1918 host-gateway interface (default port 19443, validated and distinct from service ports).
   Never bind `0.0.0.0`, terminate TLS, inspect bytes, or serialize endpoint/credential material.
   Then run outcome/repair: stored orphans must repair
   idempotently, while genuinely absent accepted-loss bytes must remain explicitly actionable and
   the recording incomplete. Then run 100/101 capacity, 25-session
   classroom; 100-session backpressure burst; and 10-session 30-minute soak. Fault evidence must
   close every captured frame across accepted/rejected/lost/uncertain and independently close the
   transmitted subset across accepted/rejected/durable-loss/uncertain.
6. Extend Docker CI with a bounded production-image realtime smoke and workflow path filters. It
   proves non-root boot, exact valid/invalid ack behavior, liveness after hostile input, and cleanup;
   it emits no full W3.8 pass artifact and cannot replace isolated staging soak/fault proof.
7. Update ADR-0051/0052 with ADR-0054, architecture, testing, staging, monitoring, parent plan,
   Compose comment, and the W3.8 evidence/runbook boundary. Document Web incompatibility, Flutter
   W4.11 dependency, Rust/no-traffic status, exact profiles, stop conditions, artifact handling, and
   recovery/cleanup procedure.
8. For each implementation slice, fetch and compare parallel work, add the red test first, run the
   focused proof then `bash scripts/verify.sh`, review the exact diff, commit conventionally, push
   without force, and wait for exact-SHA required CI. After the implementation SHA exists, select
   immutable images and run the full release proof against that exact SHA; preserve failed evidence.
9. Only after the full artifact validates, add the privacy-safe evidence note, rerun canonical
   verification, commit/push closure, wait for closure-SHA CI, and use `scripts/update-ledger.sh` to
   check W3.8. Keep the branch clean, synchronized, and leave Rust traffic unchanged for W3.9.

## Exact implementation surface

- Audio/rate contract: `server/src/realtime/audio.mjs`, `server/src/routes/recitation.mjs`,
  `services/platform-api/src/handlers/recitation.rs`, `packages/contracts/{src/index.ts,openapi.yaml}`,
  `tests/api-parity/realtime-ticket.test.mjs`, `tests/realtime/backpressure.test.mjs`, contract tests,
  and `apps/flutter/{lib/src/practice/streaming_recorder.dart,test/streaming_recorder_test.dart}`.
- New release proof: `docker-compose.realtime-proof.yml`,
  `scripts/lib/realtime-image-evidence.mjs`, `scripts/lib/realtime-image-probe.mjs`,
  `scripts/realtime-image-proof.mjs`, and `tests/release/realtime-image-evidence.test.mjs`.
- Gate/image automation: `scripts/verify.sh`, `tests/contract/verify-invocations.test.mjs`,
  `.github/workflows/docker-build.yml`, and existing production/release/topology tests only where a
  red regression requires a clarified assertion. No lockfile or runtime dependency change.
- Decisions/operations: `docs/DECISIONS.md` (ADR-0054 plus implementation notes),
  `docs/architecture/10-10-platform.md`, `docs/{TESTING,STAGING_RUNBOOK}.md`,
  `monitoring/README.md`, base Compose's stale Node-realtime comment, parent plan/impact map, and
  `specs/lean-flutter-node-consolidation/evidence/W3.8-realtime-production-image.md` at closure.
- `server/src/realtime/{main,protocol,admission,replay,outcomes}.mjs`, ticket/ack fixtures, Rust
  gateway runtime, database schema, storage adapter, recovery controller, Web source, Flutter
  recovery state machine, release selection schema, HTTP canary evidence, public routes, proxies,
  and deployable image inventory stay unchanged unless an approved-plan red test proves an exact
  listed assumption false; any expansion requires an amended impact map and renewed approval.

## Risks and rollback

- Existing clients that depended on 24/48 kHz lose those advertised choices; the current official
  Flutter request already defaults to 16 kHz. Because traffic stays on Rust and W4.11 is not yet
  complete, this is a contract correction before cutover, not an in-production wire break.
- Exact framing deliberately makes today's arbitrary Flutter device chunks and Web MediaRecorder
  output ineligible. Allowing mislabeled audio would corrupt Quran timing; W4.11 must buffer PCM into
  exact frames, while React remains on the preserved Rust path until retirement.
- Load bars are deliberately fixed before measurement. If the candidate misses them, optimize the
  bounded implementation or capacity policy and rerun a new artifact; never lower a bar after seeing
  results without a new owner-approved plan.
- “Repair” never means recreating missing learner audio. A durable accepted-loss row with no object
  remains actionable; only an extant immutable object can be indexed and marked repaired. Evidence
  closes the equation across repaired plus outstanding states and rejects any claim that such an
  incomplete recording is complete.
- A client-uncertain frame is not relabelled as a stored orphan. Evidence separately counts
  unresolved uncertainty; only an observed immutable object without its exact index is repairable.
- A client-dropped frame that never crossed the socket is not relabelled as `accepted-lost`.
  Durable loss can be lower than aggregate loss and can never exceed it; only an observed durable
  outcome contributes to repair/actionable database accounting.
- Rollback of implementation restores the earlier issuer/runtime contract and removes proof-only
  files. Evidence is external/write-once and requires no database rollback. No destructive schema,
  canonical Quran data, learner feedback, or stored learner record is introduced by this slice.

## Verification boundary

Focused/unit/canonical tests prove policy and implementation. W3.8 completion additionally requires
real immutable registry references, clean exact source SHA, live restricted Postgres, production S3,
the selected Rust oracle, all measured profiles including the full 30-minute soak and faults, exact
artifact validation, clean Git, non-force push, and exact-final-SHA remote CI. A skip, fixture,
source process, mutable tag, short smoke, or hand-authored metric cannot satisfy this boundary.

**APPROVAL RECORDED:** The repository owner approved the exact format, threshold, and evidence
surface on 2026-08-10. Any expansion outside the listed files or non-goals requires an amended
impact map and renewed approval.

# Number-one Kurdish Quran AI — refreshed research map

**Date:** 2026-08-15
**Phase:** research/planning only; no product code or tests changed.
**Refs:** local `5be8a41`; consolidation remote `3e6bec4`; live main `942ea7e`.

## Release/task truth
- Local consolidation is 1 commit behind its remote and diverges from live main by 96 local-only / 37 main-only commits; there is no single releasable candidate.
- Live-main CI for `942ea7e` is green, but GitHub has no deployment, environment, release, tag, Pages site, successful release image, or release-challenge run.
- Draft consolidation PR #388 is dirty/unmergeable and its remote tip has no check runs; its GHCR/release-overlay repairs are therefore unexercised.
- Public main's release workflow keeps only host-local tags, its cutover guard falsely treats a build as rollback evidence, and its separate challenge workflow cannot identify/download a producer-run artifact or run the full release gate.
- The checkout contains 131 unchecked Markdown boxes. Only 76 are active after reconciliation: 40 consolidation, 31 current-main readiness, 3 DR, and 2 migration entries.
- Live main closed P2.6, P5.3, and P6.1 after the local branch diverged; they remain regression obligations, not new tasks.
- Historical `docs/superpowers/*`, `docs/10-10-true-implementation-plan.md`, and old proof checklists are superseded and must not drive checkbox completion.
- The all-checked `number-one-release` ledger is also invalid for current claims: its manifest binds an obsolete SHA and null image digests.
- All 13 candidate-bound human signatures in `docs/readiness/SIGNOFF_REGISTER.md` remain pending.

## Relevant files, symbols, and flows
- `apps/web/src/data/platform.ts`: `localeCapabilities`, `getSelectableInterfaceLanguages`, `resolveSelectableInterfaceLanguage`; only English is selectable.
- `apps/web/src/locales/ckb.json` is empty. The bounded Sorani Quran translation has 39 surahs / 856 of 6,236 ayahs / one recorded omission; Kurmanji and Badini are absent.
- `apps/flutter/lib/main.dart` and `src/{api,auth,feedback,practice,privacy,reader,review,shell}` are the target product; W4.1–W4.15 remain open.
- `apps/flutter/lib/src/practice/streaming_recorder.dart` connects consent, PCM capture, ticketing, and realtime transport; physical microphone/device behavior is unproven.
- `server/src/app.mjs`, `routes/*`, `realtime/*`, `jobs/*`, `storage/*`, and `inference/*` form the converging Node backend.
- `server/src/lib/{db,ticket,learner-feedback-gate,model-attribution}.mjs` protect tenant, realtime, learner-output, and provenance boundaries.
- `services/asr-inference/{server.py,forced_align.py,acoustic_tajweed.py,calibration_registry.py}` are the current isolated ASR/acoustic path.
- `packages/contracts` and `packages/quran-data` own learner-output gates and immutable canonical/reviewed data.
- `scripts/{release-manifest,release-challenge,release-images,http-canary-controller,load-test}.mjs`, Compose/workflows, monitoring, backup/restore scripts own release evidence.
- Existing Serena-grounded maps: `specs/readiness-recovery-10-10/impact-map.md` and `specs/lean-flutter-node-consolidation/impact-map.md`.
- Serena is configured only for `/Users/hawzhin/Codystem` in this task and refuses QrAi paths; implementation must reactivate Serena on QrAi before touching any symbol.

## Current behavior
1. Canonical Quran bytes/provenance, RLS, privacy lifecycle, source/review gating, Node/Rust parity, and broad CI are strong.
2. Public main now covers a stubbed-ASR mobile finalize journey and safer failure states; this is integration proof, not model or physical-device proof.
3. Acoustic Tajweed remains shadow-only and uncalibrated; learner findings are correctly withheld rather than invented.
4. No approved held-out Kurdish-learner corpus, calibrated candidate, external reproduction, real learner pilot, or measured learning gain exists.
5. ADR-0022 now accepts digest-pinned registry artifacts, so DR T4 is no longer decision-blocked; the rehearsal/evidence still must run.
6. ADR-0038 supersedes proposed ADR-0025: public register/login should be retired, so migration N12b must close through explicit retirement proof, not bcrypt implementation.

## Integration order and risks
- First reconcile branches and ledgers; otherwise an agent will implement against stale task status or certify the wrong commit.
- Evidence/governance precedes data collection; model evaluation precedes learner-facing acoustic claims; Flutter parity precedes client retirement; live canaries precede Rust retirement.
- Human scholar, legal/privacy, security, SRE, accessibility, device, pilot, and release decisions cannot be generated or self-signed by an agent.
- Never normalize canonical Quran text, mutate a corpus in place, fabricate evaluation/signoff evidence, expose unreviewed feedback, or merge/deploy from a dirty/unapproved candidate.
- The winning moat remains a scholar-governed, Kurdish-dialect-native learning system with a consented natural-error corpus, calibrated abstention, teacher escalation, and independent outcomes—not a generic chatbot.

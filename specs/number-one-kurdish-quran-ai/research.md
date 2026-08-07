# Number-one Kurdish Quran AI — research map

**Date:** 2026-08-05<br>
**Phase:** research only; no product code or tests changed.<br>
**Detailed report:** [`audit-2026-08-05.md`](audit-2026-08-05.md)

## Relevant files and symbols

- `apps/web/src/App.tsx`: `AuthenticatedApp`, `startPractice`, `toggleAsrRecording`, `runAlignmentAndTajweed`, `saveProgressFromPractice` orchestrate the learner loop.
- `apps/web/src/components/PracticeFlow.tsx`: `PracticeFlow` renders listen → guided → memory → correction → drill → complete.
- `apps/web/src/components/QuranReader.tsx`: `QuranReader` preserves canonical text and renders word state/translation/playback.
- `apps/web/src/components/TeacherSurface.tsx`: `TeacherSurface` loads sessions, alignments, findings, and submits reviews.
- `apps/web/src/data/platform.ts`: `localeCapabilities`, `getSelectableInterfaceLanguages`, `fetchMemorizationPlan`, teacher/scholar summaries.
- `apps/web/src/locales/ckb.json`: empty; ordinary Kurdish interface is unavailable.
- `apps/web/src/lib/serverAsr.ts`: `startRecordedAudio`, `transcribeWav`, `forceAlign`; web feedback is stop-then-batch.
- `apps/web/src/lib/liveRecitation.ts`: mic chunks and gateway upload exist, but no live recognition events are connected.
- `services/ml-inference/server.mjs`: `predictAlignment`, `predictTajweed`, `transcribeAudio`, retention/audit paths.
- `services/ml-inference/alignment.js`: `normalizeArabic`, `alignWords`, `calculateConfidence`; real Quran-constrained text alignment.
- `services/ml-inference/tajweed.js`: `analyzeWord`, `analyzeAyah`; detects expected textual rule locations, not learner acoustic performance.
- `services/asr-inference/server.py`: generic/Quran ASR plus experimental acoustic features; Compose readiness can be false-green.
- `services/realtime-gateway/src/lib.rs`: ticket/origin/backpressure/retry logic; replay dedup falls back to process memory.
- `services/platform-api/src/handlers/ml_proxy.rs`: actor/consent enforcement and canonical-text finding persistence.
- `services/platform-api/src/handlers/review.rs`: real teacher review and basic scholar-approval APIs.
- `packages/contracts/src/index.ts`: `canShowLearnerFacingAiOutput` fails closed on source/review/confidence.
- `packages/quran-data/src/data/full-quran/manifest.json`: 114 surahs, 6,236 ayahs, 82,456 tokens.
- `infra/migrations/0003_tenant_rls.sql` + `infra/provision/app-role.sql`: forced tenant RLS and restricted app role.
- `docker-compose.yml`, `.github/workflows/ci.yml`: deployment migration lists diverge; observability/readiness gaps remain.
- `specs/readiness-recovery-10-10/tasks.md`: authoritative ledger has 17 done / 34 open and no release candidate.

## Current data flow

1. Learner consent/session → recorded WAV or browser transcript → platform proxy → ML alignment.
2. `predictAlignment` compares recognized words to immutable canonical words and returns evidence/review metadata.
3. `predictTajweed` independently scans canonical text; it receives no learner audio/transcript and therefore cannot prove a pronunciation error.
4. Alignments/findings may persist → teacher reviews → contract gate only exposes sufficiently confident, sourced, reviewed output.
5. Gateway transports/stores chunks, but streaming ASR/word events are not wired into the learner flow.

## Grounded behavior

- Strong: canonical integrity, privacy/consent, tenant isolation, review gates, real sequence alignment, SM-2 persistence, failure-aware code.
- Weak: Kurdish UI 1/10, acoustic tajweed 2/10, pedagogy 3/10, scholar workflow 1/10, real-world evaluation 1/10.
- Overall current learner product: **3.5/10**; reliability/production proof: **4.5/10**; underlying safety/data architecture: roughly **7/10**.
- Current honest label: safety-conscious Quran-recitation platform prototype, not yet a Kurdish-first AI tutor or proven realtime tajweed coach.

## Highest risks

- Canonical-text rule annotations can be mistaken for judgments about what the learner pronounced.
- No held-out Kurdish-L1 learner corpus, child/device/noise slices, calibrated confidence, or independent qari study exists.
- Compose schema drift, false-green ASR health, unbounded ML→ASR fetch, memory fallback for replay protection, single-host audio/audit, and no live paging/DR proof prevent a reliability claim.
- Teacher findings can be associated by repeated `wordId`; provenance is omitted from the teacher UI; persistence can race tajweed prediction.
- Empty `ckb` resources and 856/6,236 translated ayahs mean “Kurdish-first” is not a current product truth.
- Visual flow screenshots could not be captured: local preview ran, but the in-app browser blocked local URLs and connected Chrome was unavailable; visual/accessibility polish remains unverified.

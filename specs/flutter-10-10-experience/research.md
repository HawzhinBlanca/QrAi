# Flutter 10/10 experience — research

## Scope and evidence
- Target: one Kurdish-first Flutter client for learner, teacher, and scholar journeys; Node remains authority.
- Audited `apps/flutter/lib/**`, `apps/flutter/test/**`, W4.1–W4.15, ADR-0039, and the W4 impact map.
- Serena was attempted first but this workspace exposes only a TypeScript language server; Dart symbols/callers were mapped with exact declarations and `rg` references.
- Local Flutter execution is unavailable (`flutter: command not found`); current GitHub Android/build/verify checks are green but do not replace the W4 physical-device gate.

## Current product/data flow
- `main.dart`: English-only `MaterialApp`; `HomeShell` exposes Read, Practice, Progress, Privacy, and role-gated Review.
- `ReadTab -> SurahScreen -> MushafPage -> AyahView`: immutable Arabic is rendered verbatim/RTL; no translation, range CTA, playback, bookmark, or offline repository.
- `PracticeScreen -> ApiClient`: learner types surah/ayah numbers, chooses consent, creates session/ticket, starts one recorder, stops, finalizes, predicts, then reads stored findings.
- `StreamingRecorder`: one ticket/socket, PCM chunks forwarded directly; no exact-frame accumulator, ack reader, retry window, reconnect, drop accounting, or batch fallback.
- `TajweedFinding.isLearnerVisible -> TajweedPanel`: strong acoustic/source/review/span/model/dataset/calibration/evidence/audit gate; pending and approved states are distinguished.
- `ProgressTab` is read-only; no server-finalized exactly-once progress command or focused review journey.
- `ReviewQueueScreen` is tenant-wide and non-paginated; it lacks session context, audio seek/span playback, persisted edited wording, and scholar workflow.
- `TokenStore` is secure, but release enrollment/session rotation/revocation is absent; build-time tokens are correctly debug-only.
- `LoadState` models stale data honestly, but no repository/cache produces `Stale`; API/models remain handwritten.

## Proven strengths to preserve
- Canonical Quran bytes are never normalized/trimmed; Arabic direction does not depend on UI locale.
- Consent and microphone ownership are fail-closed, with microphone release on failure/disposal.
- Learner AI feedback is withheld without human approval, source, calibrated evidence, audio span, and audit identity.
- Privacy export/delete, role navigation, typed transport errors, and failure messaging have focused widget/unit tests.
- Runtime dependency set is intentionally small; new packages require an ADR and measurable value.

## Current external bar (checked 2026-08-11)
- Flutter 3.44 guidance favors View/ViewModel plus repositories/services; its offline-first guide makes repositories the local/remote source of truth.
- Flutter `gen-l10n` generates ARB localization; official accessibility tests cover labels, target size, and contrast; `integration_test` supports physical devices/Firebase Test Lab.
- OpenAPI Generator `dart-dio` remains stable and supports bearer auth/composite schemas; ADR-0039 already pins 7.22.0 and deterministic generation.
- WCAG 2.2 AA adds focus visibility/not-obscured, non-drag alternatives, and minimum target requirements.
- QuranEnc exposes versioned Kurdish translations under no-modification/source/version/update terms; dialect, completeness, license acceptance, and scholar review still require owner evidence.
- Tarteel's current table stakes include real-time word errors, listening, goals, history, and configurable Mushaf; Quran.com covers trusted content/audio breadth; Quranly covers habit formation.
- 2025–2026 Quran speech work (QDAT, Quran-MD, Tadabur, pronunciation-error research) is candidate/evaluation input only; none replaces Kurdish-L1 held-out calibration and scholar review.

## Integration points and principal risks
- Contract: `packages/contracts/openapi.yaml` -> generated Dart boundary -> repositories -> view models -> existing views.
- Realtime: W3.7 reference recovery -> W4.11 Flutter controller; server ack remains enqueue truth, not durable-success truth.
- Content: immutable Quran bundle plus separately versioned translation, recitation, timing, reviewer, and license manifests.
- Identity: W2.16 one-time device exchange -> secure storage -> reactive session rebuild; login remains owner-gated off.
- Main risks: false “Kurdish complete” claims, trendy uncalibrated AI, audio loss disguised as success, parallel handwritten/generated clients, offline stale data shown as live, and deleting React/Expo/Rust before proven parity/rollback.
- Product risk: copying broad competitors. Defensible focus is the best Kurdish-first, teacher-reviewed recitation coach, not another generic Quran super-app.

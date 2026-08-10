# Flutter 10/10 experience — specification

## Objective

Ship one lean Flutter product that is genuinely Kurdish-first, trustworthy for Quran learning,
resilient on ordinary phones and networks, and demonstrably able to replace the transitional
React/Expo clients. “10/10” is an evidence gate, not a visual rating.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| UXP-1 | WHEN a locale is enabled, THE app SHALL expose 100% of critical learner/teacher/scholar/privacy strings through generated ARB resources, require reviewer/source/version/completion/expiry evidence, use correct RTL/LTR behavior, and fail closed rather than advertise an incomplete Sorani or Arabic locale. | `localization_governance_test.dart`, `rtl_journey_test.dart`, `tests/contract/flutter-locales.test.mjs` |
| UXP-2 | WHEN Quran text, translation, recitation, or timing is displayed or played, THE app SHALL preserve canonical Arabic bytes, bind every non-canonical asset to an immutable checksum/license/source/reviewer/version, expose actual translation coverage, and never machine-translate verified Quran content. | `canonical_text_test.dart`, `content_manifest_test.dart`, `translation_coverage_test.dart`, `reference_audio_test.dart` |
| UXP-3 | WHEN a learner selects an ayah or range in the reader or Today screen, THE app SHALL carry the exact `QuranRef` into practice without retyping and SHALL provide a clear listen → guide → record → review entry path. | `reader_to_practice_journey_test.dart`, `guided_practice_journey_test.dart` |
| UXP-4 | WHEN guided practice runs, THE app SHALL support licensed reference playback, reviewed word timing/highlighting, interruption-safe pause/resume, recording, honest analysis states, focused drills from eligible evidence, and an explicit completion outcome without ornamental or fabricated rewards. | `audio_timing_controller_test.dart`, `guided_practice_journey_test.dart`, physical playback integration test |
| UXP-5 | WHEN backpressure, disconnect, ticket expiry, app lifecycle change, permission loss, or stop occurs, THE recorder SHALL use exact 15,360-byte PCM16LE frames, bounded FIFO buffering, fresh-ticket reconnect with bounded backoff/jitter, ack/drop/loss accounting, consent-preserving batch fallback, and an honest final state with no unclassified captured frame. | `streaming_recovery_test.dart`, `streaming_recorder_test.dart`, `device_failure_states_test.dart`, physical network-loss evidence |
| UXP-6 | WHEN a session becomes eligible server-finalized evidence, THE app SHALL write progress exactly once, render only the server schedule, refresh across devices, and show pending/approved/withheld/retry history without converting absent or unreviewed evidence into success. | `progress_write_test.dart`, `reviewed_feedback_inbox_test.dart`, delayed-review E2E |
| UXP-7 | WHEN a device is enrolled, refreshed, revoked, expired, unauthorized, offline, exported, or erased, THE app SHALL use one-time owner-gated enrollment, platform-protected credentials, reactive session rebuilding, explicit stale/offline state, and privacy operations that never embed reusable release credentials or expose another learner. | `enrollment_controller_test.dart`, `offline_state_test.dart`, `privacy_screen_test.dart`, signed-artifact secret scan |
| UXP-8 | WHEN a teacher reviews a finding, THE app SHALL show the correct learner/session context, retained-audio availability, exact evidence span, source/model/calibration/audit provenance, and SHALL persist accept/reject/edited wording with immutable lineage and safe retry behavior. | `teacher_journey_test.dart`, `finding_audio_controller_test.dart`, API/RLS/authz parity |
| UXP-9 | WHEN a scholar makes a decision, THE system SHALL provide a server-derived pending candidate with immutable target hash, source scope, risk, audit actor, decision history, and SHALL refuse disconnected free-text or high-risk/sourceless approval. | `scholar_journey_test.dart`, migration/RLS/OpenAPI/authz tests |
| UXP-10 | WHEN any supported journey is used with TalkBack, VoiceOver, keyboard, switch control, 200% text, dark mode, reduced motion, or RTL, THE app SHALL meet WCAG 2.2 AA, Flutter label/target/contrast guidelines, visible/unobscured focus, logical reading order, and non-color-only feedback. | `a11y_matrix_test.dart`, Flutter guideline tests, signed physical accessibility evidence |
| UXP-11 | WHEN a release candidate is built and observed, THE product SHALL pass clean generated-client drift, unit/widget/integration/security/privacy tests, signed Android/iOS/Web device matrices, zero P0/P1 defects, privacy-safe fixed-cardinality telemetry, and owner-approved crash/core-journey/performance SLOs frozen before measurement. | `tests/release/device-evidence.test.mjs`, `flutter-release-evidence.test.mjs`, CI/release gates |
| UXP-12 | WHEN the exact candidate is tested by representative Sorani-speaking learners, teachers, and scholars, THE release SHALL require at least 95% critical-task completion, SUS at least 85, no unresolved doctrinal/content blocker, and a signed evidence artifact; automation SHALL validate but never fabricate the human study. | `tests/release/flutter-ux-evidence.test.mjs`, evidence mutation/refusal/expiry tests |

## Non-goals

- No new Flutter project, second design system, generic chatbot, social feed, decorative dashboard,
  or free-form AI religious ruling.
- No React/Expo/Rust deletion until signed Flutter parity, canary, rollback, and observation gates pass.
- No production model claim from a paper, fixture, public dataset, or uncalibrated confidence score.
- No canonical Quran normalization, automatic translation, or mutation of a licensed translation.


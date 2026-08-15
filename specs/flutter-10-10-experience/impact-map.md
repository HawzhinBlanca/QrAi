# Flutter 10/10 experience — impact map

Serena cannot index Dart in this workspace (only TypeScript is active), so Dart callers below were
resolved by exact declaration/reference search and existing tests. Backend JavaScript symbols must
receive Serena `find_referencing_symbols` again immediately before implementation because parallel
work may move them.

| Boundary/symbol | Current callers | Planned change | Regression proof |
|---|---|---|---|
| `main.dart::{QrAiApp,HomeShell}` | `main`; `app_test.dart`; `main_locales_test.dart` | generated locales, app session, role-specific lean navigation | locale, role navigation, enrollment/session rebuild, a11y journeys |
| `main.dart::{ReadTab,SurahScreen}` | `HomeShell`; `MushafPage` | repository-backed Today/Quran flow and exact range selection | reader-to-practice, offline/freshness, canonical bytes |
| `reader::{MushafPage,AyahView}` | `SurahScreen`; `mushaf_page_test.dart` | translation/source/coverage, selection, playback/timing highlight | content manifest, timing, RTL, semantics, byte identity |
| `PracticeScreen` private start/stop/load flow | `HomeShell`; `practice_screen_test.dart`; `ApiClient`; `ConsentGatedRecorder`; `StreamingRecorder`; `TajweedPanel` | view model/commands, selected range, guided states, typed finalization | guided journey, dispose/race, pending/approved, progress idempotency |
| `ConsentGatedRecorder` | `PracticeScreen`; `consent_gate_test.dart` | preserve consent-before-construction while recorder controller changes | all existing gate tests plus lifecycle/device failure cases |
| `StreamingRecorder::{start,stop,sampleRate}` | `PracticeScreen`; recorder/live gateway tests | exact-frame accumulator, ack/retry/reconnect/drop/batch state machine | W3.7 vectors port, recovery, network loss, physical microphone |
| `ApiClient` and handwritten `models.dart` | every Flutter screen and 11+ Dart test helpers | generate `dart-dio`; migrate by endpoint family through repositories; delete handwritten boundary/`http` | generation diff, nullability/enums/auth/errors, canonical round trip, every caller test |
| `TajweedFinding.isLearnerVisible` / `TajweedPanel` | practice/inbox; gate parity tests | preserve full evidence gate; add history/focused drill without weakening | learner gate parity, no invented confidence, pending/withheld/inbox tests |
| `ProgressTab` | `HomeShell` | Today/progress repository, exactly-once server write, weekly schedule | progress write/concurrency/retry/cross-device tests |
| `ReviewQueueScreen` | role-gated `HomeShell`; review tests | paginated queue, context, audio span, provenance, persisted edit lineage | teacher journey, audio seek/no-audio, authz/RLS/idempotency |
| `TokenStore` / `Actor` | startup, app shell, token/actor tests | device exchange/refresh/revoke controller and reactive session | reuse/expiry/revocation/401/logout/secure-artifact tests |
| `LoadStateView` / `Loader` | reader, progress, feedback, review | repositories become fresh/stale/pending authority; no silent cache | offline/stale/refresh/clock and error-state tests |
| `PrivacyScreen` | `PrivacyTab`; privacy tests | localized export delivery/delete lifecycle and credential cleanup | export/delete/failure/retry/local residue tests |
| `packages/contracts/openapi.yaml` | Node route validation; parity; future generator | generator source; scholar target hash/pending queue and any idempotency contract only via approved additive change | OpenAPI completeness, API parity, generated-client diff |
| Node learner history/progress/device routes | generated repositories; current web/API tests | consume existing ownership/idempotency/identity authority; no client-derived tenant/role/schedule | tenant/RLS/authz/concurrency and delayed-feedback E2E |
| Node scholar review symbols | existing staff routes/OpenAPI/tests | additive immutable candidate/hash/history before scholar UI | migration, RLS, authz, source/risk/refusal/history parity |
| `pubspec.yaml`, Android/iOS/Web runners | Flutter build, CI, release/SBOM/license gates | only approved generator/playback/cache/telemetry dependencies; signed candidates | license/audit, artifact scan, platform builds, size/performance budget |
| Compose/proxy/release/docs | React/Rust rollback, W2/W3/W6/W7 evidence | move traffic/retire only after exact Flutter proof and observation | final topology, canary rollback, lean tree, clean clone |

## Test ownership by criterion

- UXP-1/2: localization/content/canonical suites and reviewer evidence validator.
- UXP-3/4: reader-to-practice, timing/playback, guided journey integration.
- UXP-5: recorder/recovery/device-failure plus W3.7 fixture parity.
- UXP-6: progress and reviewed inbox E2E.
- UXP-7: enrollment/offline/privacy/security artifact suites.
- UXP-8/9: teacher/scholar UI plus Node migration/RLS/authz/parity.
- UXP-10: widget guideline, WCAG/RTL, and physical assistive-technology evidence.
- UXP-11/12: exact-candidate release, device, SLO, and human-study evidence validators.


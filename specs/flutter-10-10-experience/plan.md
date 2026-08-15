# Plan — Flutter 10/10 Kurdish-first experience

**Status:** PROPOSED — no implementation authorized by this document  
**Approved-by:**  
**Maps to:** W4.1–W4.15, with release dependencies W1.5, W1.11, W2.18, W3.8, W3.9, W5, and W6

## Decision

Do **not** restart the Flutter project. The current client already contains valuable, tested safety
boundaries for immutable Quran text, consent/microphone ownership, privacy, and reviewed AI. Evolve
it vertically behind those tests into one product; replace handwritten/transitional boundaries
incrementally and delete them only after parity.

Position the product narrowly and credibly: **the best Kurdish-first, teacher-reviewed Quran
recitation coach**. Tarteel already sets the word-error/memorization bar, Quran.com the trusted
content/audio bar, and Quranly the habit bar. QrAi wins by joining reviewed Sorani guidance,
evidence-linked acoustic coaching, qualified-teacher workflow, and honest failure/recovery—not by
copying every feature.

## Lean target shape

```text
Views (role-specific, localized, accessible)
  -> ViewModels + Commands (Flutter SDK primitives; no state framework by default)
    -> Repositories (single source of truth; explicit fresh/stale/pending state)
      -> generated OpenAPI client | audio runtime | local content/cache | secure device identity
        -> Node HTTP/realtime authority + immutable reviewed content
```

Keep four product boundaries: content, practice, feedback/progress, and identity/privacy. Teacher
and scholar views consume the same generated client and evidence models. Add only dependencies that
pass an ADR, license/security review, web/native proof, and removal of the superseded dependency:
`dio` replaces `http`; one playback adapter; one cross-platform local SQL adapter if the offline
prototype proves it necessary; one privacy-safe crash/health reporter. Do not retain parallel stacks.

## 10/10 scorecard

The label is earned only when all twelve UXP criteria pass on one exact signed candidate and:

- Sorani critical journeys are 100% key-complete and human-reviewed; full-Quran translation is
  claimed only with 6,236 source/version/checksum-pinned entries, otherwise coverage is explicit.
- Every captured audio frame is classified as sent/accepted/rejected/dropped/uncertain and durable
  server outcomes remain distinct; no UI says “saved” from an enqueue ack.
- Learner findings remain acoustic, calibrated, sourced, spanned, audited, release-evidenced, and
  teacher/scholar approved; pending remains visibly pending.
- WCAG 2.2 AA and Flutter accessibility guidelines pass automatically and on real TalkBack/VoiceOver
  devices; core journeys pass at 200% text and RTL without overflow or focus loss.
- The owner freezes crash-free, cold-start, memory, practice-success, and recovery SLOs before the
  pilot; the signed pilot meets them with no P0/P1 defect and meets UXP-12 usability evidence.

## Test-first implementation sequence

### T1 — Contract-generated, role-clean shell (W4.1–W4.2)

1. Add red generator drift/security/nullability/canonical-byte tests.
2. Pin ADR-0039's OpenAPI Generator 7.22.0 `dart-dio` artifact/config; generate into a dedicated
   package and compile on Android/iOS/Web.
3. Migrate one endpoint family at a time behind repositories; remove handwritten equivalents and
   finally `http` only when the last caller moves.
4. Split navigation by role. Learner: Today, Quran, Reviews, Settings; practice is a journey launched
   from Today/Quran. Teacher: Queue, Sessions, Settings. Scholar: Approvals, Sources, Settings.
5. Introduce app-session reconstruction for enrollment/refresh/revocation without enabling general
   user login.

### T2 — Reviewed Kurdish content system (W4.3–W4.4)

1. Add generated ARB (`ckb`, `ar`, fallback `en`) plus a signed capability manifest containing
   reviewer, source, version, completion, expiry, direction, and critical-key set.
2. Move every hard-coded user string; keep canonical Arabic outside ARB. Fail CI on missing/extra
   critical keys, untranslated placeholders, bidi control hazards, or unreviewed locale claims.
3. Evaluate QuranEnc/Quran Foundation candidates legally and with Sorani scholars. Import only an
   approved immutable version; never fetch credentials from Flutter or auto-translate verified text.
4. Add reviewed Sorani onboarding and short audio guidance for the core loop when licensed native
   recordings exist; do not substitute synthetic voice without a separate quality/reviewer gate.

### T3 — Reader, reference audio, and guided loop (W4.5–W4.7)

1. Replace number fields with a reader selection model and sticky “Practice this range” action.
2. Add one interruption-aware playback/timing controller using licensed recitation and reviewed
   timing manifests; cache selected public content for offline use with checksum verification.
3. Implement listen → line/word highlight → guided recitation → record → honest pending/approved
   result → focused drill → completion. Personalized drills are deterministic from approved finding
   + exact span + licensed reference audio, never free-form LLM output.
4. Preserve scripture bytes and surface translation/source/version/coverage separately.

### T4 — Loss-aware realtime recorder (W4.11, W4.14)

1. Port the W3.7 recovery vectors into Dart as red tests.
2. Replace `StreamingRecorder`'s direct chunk forwarding with one controller that accumulates exact
   frames, reads acks, bounds frames/bytes/time, refreshes tickets, reconnects with capped jittered
   backoff, accounts for oldest-first drops, and exposes a typed final outcome.
3. Add consent-compatible encrypted temporary buffering and the existing batch ingestion fallback
   only when retention permits; erase temporary bytes after durable confirmation or refusal.
4. Prove permission revocation, phone call/audio interruption, background/foreground, process death,
   captive/offline/slow networks, server overload, and stop/finalize uncertainty on real devices.

### T5 — Progress and reviewed-feedback continuity (W4.8–W4.9)

1. Add repositories/view models for learner session history, finding inbox, progress, and weekly
   schedule using the already implemented own-only APIs.
2. Write progress with an idempotency identity exactly once only after server-finalized eligible
   evidence; render server SM-2 schedule and never calculate mastery in Flutter.
3. Support pending, approved, withheld, retry, superseded, incomplete-recording, and cross-device
   refresh; keep cached data explicitly stale.

### T6 — Teacher and scholar professional tools (W4.12–W4.13)

1. Replace the 200-row tenant list with the paginated server queue and exact learner/session context.
2. Add retained-audio playback/seek to evidence spans, provenance, accept/reject/edit, optimistic
   locking/idempotency, and immutable edit lineage.
3. Before scholar UI, extend schema/OpenAPI with server-derived pending candidate and immutable
   target hash. Then implement source/risk/history/detail views; never a detached approval form.

### T7 — Accessibility, offline, privacy, and polish (W4.14)

1. Add repository-backed offline reading/reference content; queue no learner-performance write that
   cannot be made idempotent and consent-safe. Every cached server value displays freshness.
2. Pass automated semantics/label/target/contrast tests, WCAG 2.2 AA, RTL/bidi, keyboard/focus,
   screen-reader order, 200% text, reduced motion, dark mode, and non-color-only findings.
3. Complete export/download/delete lifecycle, enrollment/logout/401/expiry/revocation, and
   privacy-safe crash/funnel metrics with no raw audio, Quran text, learner, tenant, trace, token,
   nonce, or free-form exception labels.

### T8 — Candidate-bound proof and controlled replacement (W4.15, W6–W7)

1. Run unit/widget/golden/integration tests, generated diff, signed-artifact scans, and clean-clone
   canonical/release gates for the exact Android/iOS/Web candidate.
2. Execute the physical OS/device/microphone/network/accessibility/privacy matrix and a moderated
   Sorani learner/teacher/scholar study. Validate signed, expiring evidence; automation cannot sign it.
3. Canary independently with automatic stop/rollback, then observe. Only afterwards retire Expo,
   React, Rust gateways/oracles, duplicate clients, and transitional dependencies in W7 order.

## Primary-source grounding

- Flutter: [internationalization](https://docs.flutter.dev/ui/internationalization),
  [recommended architecture](https://docs.flutter.dev/app-architecture/guide),
  [offline-first](https://docs.flutter.dev/app-architecture/design-patterns/offline-first),
  [accessibility testing](https://docs.flutter.dev/ui/accessibility/accessibility-testing), and
  [integration tests](https://docs.flutter.dev/testing/integration-tests).
- Contract: [OpenAPI Generator `dart-dio`](https://openapi-generator.tech/docs/generators/dart-dio/).
- Accessibility: [WCAG 2.2](https://www.w3.org/TR/WCAG22/).
- Content candidates: [QuranEnc API terms](https://quranenc.com/en/home/api) and
  [Quran Foundation Content API](https://api-docs.quran.com/docs/content_apis_versioned/4.0.0/content-apis/).

## Risks and rollback

- A full Sorani translation or reference-audio license may remain externally blocked. Ship honest
  reviewed coverage, not a fabricated completion claim.
- `dart-dio`, playback, local SQL, and telemetry add weight. Each must replace a boundary or prove a
  release criterion; otherwise remove it.
- Generated client defects fail migration. Never hand-edit generated output or maintain two permanent
  clients.
- Model/dataset novelty is not product evidence. W1.5/W1.11/W5 benchmarks decide promotion; the UI
  stays pending/unavailable until then.
- Keep current Flutter/React/Rust artifacts as rollback candidates through observation. Rollback is
  a route/artifact selection, not a destructive database or content change.

## Human gate

Fill `Approved-by:` above to authorize T1 only. Each task remains test-first and may be marked done
only after focused proof, `bash scripts/verify.sh`, exact-SHA CI, and any named external evidence.


# Quran AI Apple-Grade Product Blueprint

Date: 2026-06-24

## Executive Decision

Quran AI should become a learner-first recitation mastery app, not a visible platform command center.

The winning product loop is:

1. Choose today's short mission.
2. Listen to a trusted reciter.
3. Recite with the mushaf hidden or guided.
4. Receive word-level, confidence-scored feedback.
5. Practice a tiny corrective drill.
6. Retry the exact phrase.
7. Bank mastery into spaced review.
8. Escalate uncertain or sensitive findings to a teacher or scholar quietly.

The platform, teacher, scholar, model-ops, consent, and audit systems remain essential, but they should become the trust engine under the learner experience rather than the first screen.

## Current-State Evidence

Screenshots captured from `pnpm dev` on `http://127.0.0.1:5173/`:

- `docs/research/apple-grade-blueprint/01-current-desktop.png`
- `docs/research/apple-grade-blueprint/02-current-mobile.png`

Source pitch extracted from `Quran AI.pdf`:

- `docs/research/apple-grade-blueprint/quran-ai-pdf-extract.txt`

Validation run:

- `pnpm test`: passed.
- `pnpm build`: passed.
- `pnpm proof`: passed.

Current strengths:

- Strong foundation for canonical Quran text, review status, audit IDs, consent state, tenant IDs, and model-eval posture.
- React/Vite web shell already has reusable learner components: Quran reader, audio coach, issue panel, progress panel, and assistant panel.
- Rust/Tokio realtime gateway uses bounded channels and explicit backpressure counters.
- Platform API already models tenant-scoped sessions, teacher reviews, scholar approvals, eval lookup, and audit events.

Current risks:

- First impression is an internal command center, not a learner habit loop.
- Mobile viewport at 390px clips horizontally; the current top navigation and command layout are not Apple-grade responsive.
- Platform apps/tabs are visible before the learner understands the task.
- The live capture UI exposes gateway mechanics, chunks, acks, and model plumbing too early.
- Game mechanics exist as badges/streak labels, but not as a coherent mastery system.
- The current UI has a strong beige/emerald platform-dashboard feel; it needs a calmer, more native, sacred-learning interface with playful micro-feedback.

## Research Signals

Apple-grade quality means platform-native behavior, fast first use, readable hierarchy, accessible controls, clear feedback, and age/privacy responsibility. The plan should use Apple HIG, App Store Review Guidelines, and App Privacy Details as release constraints, not inspiration only.

Competitive Quran app signals:

- Tarteel owns the obvious AI memorization baseline: real-time missed, incorrect, and skipped-word detection.
- Quranly owns habit framing: daily goals, streaks, progress tracking, and small commitments.
- Quran.com owns trusted reading/listening/search/reflection breadth.
- Bayyinah/Revealed shows a useful depth pattern: keep reading light, reveal commentary only when the user asks.

Learning science signals:

- Spaced retrieval should drive review scheduling, not generic streak pressure.
- ASR feedback is valuable when it gives immediate, targeted, low-pressure pronunciation feedback.
- Gamification works best when it supports learning behavior. Avoid empty points, public leaderboards for sacred practice, and addictive pressure loops.

Trust and canonical-content signals:

- Quran text must be immutable, checksummed, and source-attributed.
- Quran Foundation content credentials must remain server-side.
- Tanzil terms allow verbatim use but prohibit changing the text and require source attribution.
- Religious explanations and tajweed advice need source, confidence, review status, and clear boundaries.

## Product North Star

Make Quran practice feel like a beautiful daily mastery game: calm, precise, respectful, and encouraging.

The user should never feel like they are "using AI." They should feel:

- I know what to practice today.
- The app listens without judging me.
- Feedback is specific and fixable.
- My progress is visible.
- Hard parts come back at the right time.
- A trusted human can review what the AI is unsure about.
- My audio and religious learning data are treated with care.

## Non-Negotiable Product Rules

1. The Quran text is the product's sacred content surface; never decorate it into noise.
2. The first screen must be usable in under 10 seconds.
3. Every AI claim must carry confidence, evidence, source, and review state internally.
4. The learner sees simple language; the system keeps full audit metadata.
5. No public competitive leaderboard for worship or recitation quality.
6. No dark patterns around streaks, subscriptions, or audio consent.
7. No unsourced religious answer reaches the learner.
8. No production release without mobile, accessibility, privacy, and model-eval proof.

## Target Experience Architecture

### 1. Home: Today's Practice

Replace `Platform Command` as the default screen with a learner home.

Primary layout:

- Greeting and one mission: "Review Al-Fatihah, ayat 5-7."
- One large `Start Practice` button.
- Three small progress indicators: streak, mastery, next review.
- Trust state shown as a small reassurance line: "Teacher-reviewed guidance enabled."
- Quiet access to Quran, Progress, Teacher, Settings.

Do not show:

- Model Ops.
- Scholar queue.
- Gateway status.
- Agent runs.
- Data flywheel.
- Raw chunks or acks.

### 2. Practice: Listen, Recite, Correct, Retry

Practice screen should be the emotional core.

States:

- `listen`: play trusted reciter with word highlight.
- `guided recite`: text visible, current word highlighted.
- `memory recite`: hide upcoming words and reveal as user recites.
- `correction`: show only the top 1-3 issues.
- `drill`: isolate the phrase and run three fast retries.
- `complete`: celebrate mastery without overplaying it.

Core UI:

- Full-width mushaf panel with pristine Arabic typography.
- Floating bottom audio control.
- Word-level feedback marks that are subtle until the user finishes.
- One error explanation at a time.
- "Try this phrase again" as the default next action.

### 3. Feedback: Fixable, Not Judgmental

For each issue:

- Show canonical word.
- Show what was detected only if useful.
- Give one corrective cue.
- Give a short listen-and-repeat drill.
- Show confidence and review state behind a small info affordance.
- Offer "Ask teacher to review" when confidence is low.

Tone:

- Use "needs practice" instead of "bad."
- Use "try again slowly" instead of "wrong."
- Keep sacred respect: no cartoonish failure states.

### 4. Mastery Map

A lean game layer:

- Surah cards with mastery rings.
- Ayah-level heatmap for stability.
- "Weak links" queue for repeated mistakes.
- Review schedule: today, 3 days, 7 days, monthly.
- Badges tied to real learning behaviors: consistency, correction, retention, teacher-reviewed completion.

Avoid:

- Random XP inflation.
- Casino-like reward timing.
- Social shame or ranking.
- Overly loud celebratory visuals.

### 5. Teacher Review

Teacher workflow should exist, but only when needed.

Learner view:

- "Sent to teacher" status.
- Teacher note when returned.
- Clear before/after audio comparison if consent allows.

Teacher view:

- Queue by confidence, severity, and learner need.
- Fast accept/edit/reject actions.
- Audio snippet plus waveform and canonical word.
- Agreement tracking for model evaluation.

### 6. Scholar and Source Trust

Scholar tooling should not dominate learner UI.

Use it for:

- Tajweed explanations.
- Religious-context answers.
- Mutashabihat explanations.
- Localization review.
- Content release approval.

Learner display:

- "Reviewed guidance" badge.
- Source drawer on demand.
- Blocked state when source/review is missing.

### 7. Family and Children Mode

The app likely serves children, families, and Quran institutions. Design for that from day one.

Required:

- Parent/guardian account path.
- Child profile privacy defaults.
- No ads in child mode.
- No third-party tracking SDKs in child mode.
- Explicit audio retention controls.
- Export/delete audio and session data.
- Age-appropriate notifications.

## Visual Design Direction

Target feel:

- Quiet, premium, sacred, warm, and precise.
- Apple-native density and motion, not a web dashboard.
- Light surfaces, high contrast text, generous whitespace, crisp controls.
- Arabic text is visually central and never crowded.

Palette:

- Keep emerald as trust/action.
- Use ivory/paper sparingly; avoid letting beige dominate the app.
- Add ink, deep green, soft gold, and neutral grays for hierarchy.
- Use red only for severe correction; use amber for practice.

Typography:

- Arabic: keep a high-quality Quran-friendly face and tune line height aggressively.
- UI: Inter or platform system font.
- Never scale font size directly by viewport width.
- Validate Sorani, Arabic, Urdu, English, and Turkish in the same layout.

Motion:

- Use micro-motion for word tracking, recording state, completion, and correction transitions.
- Respect `prefers-reduced-motion`.
- Use haptics in native mobile for start, stop, correction found, and mastery complete.

## Technical Blueprint

### Frontend

Near-term:

- Split current `PlatformCommand` into learner-first routes.
- Reuse `QuranReader`, `AudioCoach`, `IssuePanel`, and `ProgressPanel`.
- Add responsive shell: mobile bottom nav, desktop sidebar, tablet split view.
- Remove all fixed min widths that cause mobile overflow.
- Add route-level states and empty/error/loading states.

Future native path:

- Build Expo or SwiftUI once the web learner loop is proven.
- Use native audio session handling, haptics, offline cache, background-safe uploads, and family/child controls.

### Realtime

Keep Rust/Tokio as the realtime spine.

Add:

- Authenticated WebSocket session tickets.
- Per-session cancellation and idle timeout.
- Backpressure-aware client UI.
- Persisted audio event metadata.
- NATS/JetStream events for downstream alignment.
- OpenTelemetry spans from browser chunk to gateway to alignment output.
- Chaos tests for disconnects, duplicate sessions, slow consumers, and partial uploads.

### ML and Quran Alignment

Pipeline:

1. Browser/native client captures audio.
2. Gateway validates, bounds, and streams chunks.
3. ASR/alignment service produces Quran-constrained word candidates.
4. Tajweed classifier produces advisory findings.
5. Confidence gate decides learner display vs teacher review.
6. Reviewed corrections feed eval sets and training labels.

Thresholds before learner release:

- Word alignment F1 >= 0.90 on curated Al-Fatihah + Juz Amma.
- Tajweed false-positive rate <= 8% for advisory findings, moving toward <= 5%.
- Teacher agreement >= 90%.
- Unsourced/draft religious explanations displayed to learner: 0.
- P95 live feedback latency <= 600ms for local/regional pilots.

### Data and Privacy

Default:

- Audio retention is `discard`.
- Teacher review requires explicit consent.
- Training use requires separate opt-in.
- Institution tenancy is enforced at DB, object storage, and API layers.

Required production systems:

- Postgres + SQLx with migrations.
- Row-level security for tenant records.
- Object storage with per-tenant keys and retention policies.
- Audit events for every AI output and human review.
- Export/delete endpoints and tests.
- Privacy label inventory for every collected data type.

### AI Agents

Agents are supervised tools, not religious authorities.

Allowed:

- Drafting learner-friendly explanations from approved sources.
- Localizing reviewed explanations.
- Creating practice drills.
- Summarizing teacher review.
- Routing low-confidence items.

Blocked:

- Fatwa-like answers.
- Unsourced religious claims.
- Editing canonical Quran text.
- Learner-facing answer without source/review gates.

Use SDK/tool orchestration only where the app owns state, approvals, and audit trails.

## Quality Gates

Minimum local gate:

```bash
pnpm proof
```

Add before premium learner release:

- Browser E2E: onboarding, start practice, mic allow/deny, one chunk upload, feedback display, retry drill, complete session.
- Real browser mic matrix: allowed, denied, no device, interrupted permission, tab backgrounded.
- Responsive visual proof: 390px, 430px, 768px, 1024px, 1440px, RTL/LTR.
- Accessibility: keyboard-only path, focus visible, VoiceOver labels, WCAG 2.2 AA target where practical.
- Performance: first screen interactive < 2s on mid-tier mobile, no horizontal overflow, no layout shift in practice loop.
- Realtime: 100, 1,000, and pilot-target concurrent sessions with p95 latency and backpressure proof.
- Privacy: audio discard, retention opt-in, export, deletion, consent revocation.
- Model eval: word alignment, tajweed F1, false positives, teacher agreement, blocked unsourced answers.
- Security: tenant isolation, auth ticket expiry, object storage access, audit tamper checks.

## Roadmap

### Phase 0: Product Truth Reset

Goal: define the product as learner-first.

Deliverables:

- Rewrite app information architecture.
- Define learner state machine.
- Define data contract for practice session, issue, drill, review, mastery.
- Keep platform command as internal/admin mode only.

Exit gate:

- A new spec where every first-run screen has one primary user action.

### Phase 1: Learner Shell

Goal: fix the first impression.

Deliverables:

- Mobile-first home.
- Practice route.
- Bottom audio coach.
- Responsive Quran reader.
- No mobile horizontal overflow.
- Current platform metrics hidden behind admin/dev mode.

Exit gate:

- Desktop and mobile screenshots pass visual inspection.
- Keyboard and screen-reader smoke pass.
- `pnpm proof` stays green.

### Phase 2: Practice Loop

Goal: make recitation feel like a mastery game.

Deliverables:

- Listen/guided/memory modes.
- Correction summary.
- Phrase retry drill.
- Completion state.
- Mastery update.
- Spaced review queue.

Exit gate:

- A learner can complete one full Al-Fatihah practice loop with mocked alignment.

### Phase 3: Real Realtime Slice

Goal: replace mocked alignment with a bounded, observable live path.

Deliverables:

- Authenticated gateway tickets.
- Browser-to-gateway real WebSocket proof.
- Downstream ASR/alignment service stub.
- Event stream from chunk to partial alignment.
- Failure and reconnect states.

Exit gate:

- Live browser capture produces real server-side event traces.

### Phase 4: Trust and Review

Goal: make AI safe enough for a Quran learning pilot.

Deliverables:

- Teacher review queue.
- Scholar-approved explanation library.
- Source drawer.
- Low-confidence escalation.
- Audit ledger UI for admins.

Exit gate:

- Unsourced learner-facing religious answer count is provably zero.

### Phase 5: Pilot-Grade Mobile

Goal: make it usable daily by families and institutions.

Deliverables:

- Native app or native-quality PWA decision.
- Offline Quran text and audio cache.
- Child/family profiles.
- Notifications tuned for respectful reminders.
- Privacy labels and data inventory.
- Institutional onboarding.

Exit gate:

- Pilot release checklist signed by product, engineering, teacher reviewer, and privacy owner.

## "10x" Differentiator

The product should not try to beat every Quran app at every feature. It should beat them at one loop:

Recite, get precise feedback, correct immediately, review at the right time, and trust that sensitive guidance is human-reviewed.

That is the lean professional product.

## Source Index

- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines
- Apple HIG Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Apple HIG Feedback: https://developer.apple.com/design/human-interface-guidelines/feedback
- Apple HIG Designing for games: https://developer.apple.com/design/human-interface-guidelines/designing-for-games/
- Apple App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Tarteel: https://tarteel.ai/en
- Quranly: https://www.quranly.app/
- Quran.com apps: https://quran.com/en/apps
- Revealed App Store listing: https://apps.apple.com/us/app/revealed-a-quran-study-app/id6758270462
- Duolingo spaced repetition paper: https://research.duolingo.com/papers/settles.acl16.pdf
- ASR pronunciation feedback study: https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1210187/full
- Gamification meta-analysis: https://link.springer.com/article/10.1007/s10648-019-09498-w
- Quran Foundation API docs: https://api-docs.quran.foundation/
- Quran Foundation Content API quickstart: https://api-docs.quran.foundation/docs/quickstart/
- Tanzil Quran text: https://tanzil.net/download/
- FTC COPPA rule: https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- OpenAI Realtime and audio docs: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Agents SDK docs: https://developers.openai.com/api/docs/guides/agents

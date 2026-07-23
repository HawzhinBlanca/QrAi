# Readiness inventories (P2.1, P3.1, P5.2)

Derived from the code on 2026-07-23. These are engineering artifacts (I can produce them); the
product/scholar/owner **decisions** they feed (which locales to advertise, scope approval, SLO
values) are tracked in `OPERATIONS.md` / `SIGNOFF_REGISTER.md` and remain human-gated.

---

## P2.1 — Visible strings + advertised locales

**UI strings.** All learner/teacher/internal-facing copy is in `apps/web/src/locales/en.json`, one
namespace per surface (26): `topBar, sidebar, login, consent, progress, learnerHome, practiceSteps,
practiceFlow, quranReader, surahPicker, micNotice, modeBanner, completePanel, issuePanel,
offlineBanner, errorBoundary, audioCoach, tajweedPanel, mutashabihatPanel, internalSurface,
memorizationPlan, platformCommand, app, privacySettings, teacherSurface`. Access is via
`react-i18next` `t()` (no hardcoded user-facing literals in the extracted components).

**Advertised vs. delivered locales.**

| Code | Language | Content status | Advertised? |
|------|----------|----------------|-------------|
| `en` | English | **Complete** (`en.json`) | Yes — the only complete UI locale |
| `ckb` | Kurdish Sorani | **Empty** — `EMPTY_TRANSLATION`, falls back to `en` (i18n/index.ts) | Default `lng` but content is English |
| `ar, tr, ur, id, ms, fr, de` | (7 more) | No UI resource bundle | Listed in `SUPPORTED_LANGUAGE_CODES` (contracts) |

`SUPPORTED_LANGUAGE_CODES` (packages/contracts) catalogs 9 codes; only `en` has a resource bundle.
`fallbackLng:"en"` makes every key resolve to real English rather than a raw key.

**Honesty gap → P2.3/P2.4 (product/scholar):** the app must NOT advertise `ckb`/`ar`/… UI as
"available in your language" while it serves English (ADR-0012). The language selector should either
show only `en` as complete, or clearly label the others as "English shown until reviewed content
ships". Delivering reviewed Sorani/Arabic content is P2.4 (scholar-gated).

---

## P3.1 — Learner-visible feedback provenance

Every result a learner can see, its source, and its review gate:

| Feedback | Source / model | Review gate before it reaches a learner | Provenance / limitation |
|----------|----------------|------------------------------------------|--------------------------|
| **Tajweed findings** (rule, severity, explanation) | ML tajweed model (`ml-inference`) | `canShowLearnerFacingAiOutput` (contracts): withheld unless `reviewStatus == teacher-reviewed` **and** sourced **and** confident. Live AI output is labeled provisional, never "verified". | mushaddad-ghunnah rule is deliberately withheld pending scholar ruling (ADR-0013). Scholar scope approval = P3.6. |
| **Word alignment** (matched / misread / missed / extra) | Forced aligner, `modelVersion` allow-listed to `ml-aligner-v0.2` (ml_proxy runtime guard) | Shown as practice feedback (not doctrinal); confidence surfaced | Consent-gated: analysis uses the session's **stored** consent, server-overwritten (ml_proxy), not client claims |
| **Transcription** (heard text) | ASR service — generic openai-whisper `base` (docker-compose `ASR_MODEL=base`); the specialized `tarteel-ai/whisper-base-ar-quran` is server.py's default but not installed in the shipped image (ADR-0009) | Feeds alignment; not shown as doctrinal truth | Model choice is an accuracy decision documented in ADR-0009 |
| **Progress / mastery / streak** | Real SM-2 over the learner's actual practice history (`learner_progress`) | Own-data only (`require_self_or_any` + RLS) | Computed, not fabricated (SHIP_PLAN P1.1/P1.3) |
| **Quran text (ayah/word)** | `canonical_ayahs`/`canonical_words`, SHA-256 `source_checksum` (ADR-0004/0005), alquran.cloud 114-surah/6236-ayah bundle | Immutable + checksum-verified on import (`quran-data` integrity tests) | Tamper-detection tested; re-seed required if the checksum builder changes |
| **Surah names / translations** | `canonical_surahs`; Sorani translation pinned in `2026-07-19-provenance-v2` (39 files / 856 ayahs / 1 explicit omission + content hash) | Provenance-manifest gated (`translations-provenance.test.ts`) | Translation completeness per locale = P2.4 (scholar) |

**Gate is enforced in code + tests**, not just documented: `packages/contracts/tests/platform-contracts.test.ts` (the gate) and `apps/web/src/lib/tajweedReview.test.ts` (the surface).

---

## P5.2 — Per-dependency timeout / retry / degradation map

| Dependency | Timeout | Retry / backpressure | User-facing degradation |
|------------|---------|----------------------|--------------------------|
| **platform-api** (from web) | `fetchWithTimeout` 15 s hard abort (http.ts) — a hung backend can't freeze the UI | none (idempotent GETs); mutations are one-shot | `platformOffline` + `OfflineBanner` + an actionable Retry button (LearnerHome; tested) |
| **Postgres** (from platform-api) | pool acquire timeout `DATABASE_ACQUIRE_TIMEOUT_SECS` (default 10) → retryable 503 | pool `DATABASE_MAX_CONNECTIONS` (default 10) | `/ready` returns 503 when the pool can't answer (liveness `/health` stays 200) so orchestrators see "up but can't serve" |
| **ML / ASR** (from platform-api) | shared `reqwest` client 60 s timeout (covers CPU Whisper) | none; generic 502 on upstream failure (internal URL/error never leaked to the browser) | practice analysis fails gracefully; the learner keeps the reader/session |
| **Realtime gateway** (WS, from web) | single-use HMAC ticket per connect | equal-jitter backoff reconnect + bounded drop-oldest buffering (reconnect.ts, liveRecitation.ts; chaos-tested T13) | status → `reconnecting` / `degraded`; buffered audio flushes on reconnect |
| **Whole API** (ops) | — | — | **kill-switch**: `MAINTENANCE_MODE=1` → clean 503 for all but `/health`/`/ready`/`/metrics` (P5.5) |

Idempotency: progress writes upsert the caller's own row (concurrent quality=5 tested); invitation
consumption is an atomic single-use `UPDATE … WHERE consumed_at IS NULL RETURNING` (0021).

**Owner-gated (P5.1):** the numeric SLOs/RTO/RPO/error-budgets these behaviors should meet are
proposed in `OPERATIONS.md` and await owner approval.

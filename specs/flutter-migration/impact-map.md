# Flutter Migration — Impact Map

Companion to `plan.md` (AGENTS.md step 2: list affected callers before touching any symbol).
Reference counts verified at `e0f37c1` by grep across `apps/`, `packages/`, `services/`
(excluding `node_modules`).

**No symbol below is modified by this plan.** The plan proposes *duplicating* behaviour into Dart;
this map exists so the blast radius of any drift is known in advance.

---

## 1. `packages/contracts` — the ten functions that must be re-proven in Dart

| Function | Files referencing | Consequence of a Dart/TS divergence |
|---|---|---|
| `canShowLearnerFacingAiOutput` | 4 | **Unreviewed AI output reaches a learner.** Worst failure available |
| `verifyCanonicalWord` | 4 | Corrupt canonical Qur'an text passes verification |
| `verifyCanonicalAyah` | 3 | Same, at ayah granularity |
| `createCanonicalChecksum` | 3 | Checksums disagree across clients; verification silently fails |
| `createCanonicalAyahChecksum` | 2 | Same |
| `hasCanonicalTextChanged` | 2 | Text drift goes undetected |
| `mustDiscardAudio` | 2 | **Audio retained against consent** — privacy/legal exposure (P4.6) |
| `canUseExternalAsr` | 2 | Audio sent to external ASR without valid consent |
| `modelEvalPassesReleaseGate` | 2 | An unvalidated model passes a release gate |
| `sha256Hex` | 2 | Underpins the checksum functions; one byte of difference breaks all of them |

### 1.1 Exact call sites of the safety gate

```
apps/web/src/lib/tajweedReview.ts:12   findings.filter(canShowLearnerFacingAiOutput)
apps/web/src/lib/tajweedReview.ts:23   const verified = canShowLearnerFacingAiOutput(finding)
apps/web/src/lib/platform.ts:26        return canShowLearnerFacingAiOutput(agentRun)
```

Only **two** production call sites, both thin wrappers — the gate is well-contained, which is good
news for porting. Existing coverage lives in `packages/contracts/tests/platform-contracts.test.ts`
(10 assertions, including `unrecognizedStatusRun` → `false`, which pins the fail-closed allowlist
behaviour).

**Required before any Dart port of these:** promote those assertions into a language-neutral JSON
fixture corpus executed by both suites (plan.md §4.1, phase 1). The `unrecognizedStatusRun` case is
the one most likely to be lost in translation, because a naive Dart port using an enum or a
denylist would fail **open**.

---

## 2. Surfaces that move (phase 2)

| Path | Lines | Notes |
|---|---|---|
| `apps/mobile/App.tsx` + `lib/` | 661 total | Standalone Expo; **imports no `@quran-ai/contracts`** — verified. Nothing else depends on it |

No other workspace member imports `apps/mobile`; it is not a pnpm workspace member. Removing or
replacing it cannot break `apps/web`, `packages/*`, or any service.

---

## 3. Surfaces NOT moved by this plan (phase 5 decision only)

| Path | Lines | Coupled to |
|---|---|---|
| `apps/web/src` | 7,368 | `@quran-ai/contracts`, i18next (433 keys), axe a11y tests |
| `apps/web/src/lib/api.ts` | 545 | Every backend endpoint; actor headers; pilot CSRF |
| `apps/web/src/lib/liveRecitation.ts` | 404 | `realtime-gateway` WebSocket protocol |
| `apps/web/src/lib/serverAsr.ts` | 276 | `asr-inference` `/v1/transcribe`; 16 kHz mono WAV framing |

---

## 4. Backend symbols a mobile client forces us to touch (plan.md §4.3)

The pilot identity flow is browser-only and has **no mobile equivalent today**:

| Symbol | File | Impact |
|---|---|---|
| `resolve_actor` | `services/platform-api/src/auth.rs` | Would gain a bearer-token branch for mobile. Currently: Bearer JWT → `__Host-` pilot cookie → dev headers |
| `require_allowed_origin` | `services/platform-api/src/auth.rs` | Origin allowlisting is meaningless for a non-browser client — needs an explicit decision, not a bypass |
| pilot CSRF digest compare | `services/platform-api/src/auth.rs` | CSRF is a browser threat model; must not be silently dropped for mobile |

Every one of these is **security-relevant**. Changing them re-opens ledger **P4.1** (threat model)
and **P1.7** (security reviewer signs the identity boundary). Treat as backend work with a security
review, not as part of a frontend port.

---

## 5. Ledger items this plan touches

| Item | Effect |
|---|---|
| **P6.2** accessibility | Flutter port restarts a11y coverage from zero; axe automation does not transfer |
| **P2.3** locale packs | Unaffected by framework — 433 keys × 2 languages still unwritten (plan.md §1) |
| **P4.1** threat model | Re-opened by §4 mobile auth |
| **P1.7** identity boundary | Re-opened by §4 mobile auth |
| **P6.3/P6.4** device testing | Flutter changes the build/signing pipeline; existing matrix assumptions invalid |

---

## 6. Regression tests required before each phase

- **Phase 1:** shared fixture corpus runs green in TS. No behaviour change permitted — this phase is
  purely additive coverage over existing functions.
- **Phase 2:** identical corpus green in Dart. Any divergence is a hard stop, not a warning.
- **Phase 3:** `services/platform-api/tests/integration.rs` gains mobile-auth cases mirroring the
  existing pilot-cookie tests (`pilot_cookie_mutation_requires_origin_and_csrf` and siblings).
- **Phase 4:** a Dart-recorded sample must return a real transcription from the **live**
  `asr-inference` service — not a mock, since the WAV framing is the thing under test.

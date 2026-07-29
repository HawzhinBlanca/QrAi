# Flutter Migration — Plan

**Status: PROPOSED — awaiting human approval. No code is written until this is approved** (AGENTS.md
workflow step 2).
**Checkpoint:** git tag `checkpoint-2026-07-28`, main at `e0f37c1`, `verify.sh` VERIFY OK.
**Decision owner:** repo owner. **Input needed from:** the dev who proposed Flutter.

---

## 0. The argument FOR Flutter here is real — state it first

Flutter is not an arbitrary choice for a Qur'an app. It renders through its own engine (Skia/Impeller)
rather than the host browser, so **Quranic text renders identically on iOS, Android, and web**.
Browsers vary in Arabic shaping across platform, version, and font stack — for a text where a
misplaced diacritic is a correctness problem, not a cosmetic one, one engine is a genuine advantage.

Counterweight, equally real: **the market leader in this exact space (Tarteel, 8M users) chose React
Native + React**, and `apps/web` is 7,368 lines of working, tested, axe-verified React. Neither fact
settles it; both belong in the decision.

---

## 1. Correction that changes the scope

**There are no Kurdish or Arabic translations today.** `apps/web/src/i18n/index.ts:23-24` registers
`ckb` and `ar` as `EMPTY_TRANSLATION`; the app defaults to `lng: "ckb"` and falls back to English for
all 433 keys. The in-code comment shows this is deliberate — unreviewed religious-education
translation is not shipped — and ledger **P2.3** tracks it.

Consequence for this plan: **translation is a large, framework-independent workstream** (433 keys ×
2 languages, each needing a qualified reviewer). Migrating to Flutter neither helps nor hurts it, and
it must not be conflated with migration progress.

---

## 2. Scope: what moves, what does not

| Surface | Size | Proposal |
|---|---|---|
| `apps/mobile` (Expo/React Native) | 661 lines, standalone, imports no shared contracts | **Migrate to Flutter.** Low risk, low cost, high learning value |
| `apps/web` (React) | 7,368 lines src, i18n + RTL + axe-verified a11y | **Decide AFTER the §3 spike.** Not committed by this plan |
| `packages/contracts` | 42 exports, **10 of them functions** | Cannot move — see §4.1 |
| Rust/Node/Python services | — | **Unchanged.** This plan touches no backend |

Migrating mobile first is deliberate: it is the cheapest real Flutter deliverable, it exercises every
hard problem in §4 at small scale, and its outcome informs the web decision with evidence instead of
prediction.

---

## 3. The spike that gates everything (2 days, before any migration)

Build a throwaway Flutter app that does only this:

1. Render Surah Al-Fatihah and a heavily-diacritized passage (e.g. Al-Baqarah 2:1-5) in **both**
   approaches: (a) Uthmani text with system Arabic shaping, (b) **KFGQPC/QCF page fonts**.
2. Full RTL layout with mixed Arabic/Latin UI chrome.
3. VoiceOver (iOS) and TalkBack (Android) pass over the rendered text.
4. Same three checks in Flutter **Web**, plus a measured bundle size.

**Key technical finding to act on:** professional mushaf apps (Quran.com, Tarteel) do not rely on
system Arabic shaping at all. They use **King Fahd Complex QCF fonts, where each mushaf page is its
own font file with custom glyph codepoints** — the text arrives pre-shaped, so the platform's shaping
engine is bypassed. If QrAi adopts that approach, mushaf fidelity becomes **roughly framework-neutral**,
which materially weakens the strongest argument for Flutter. The spike must test this, because it
could change the decision.

**Gate:** if (a) or (b) shows diacritic placement errors, or screen readers cannot read the text,
**Flutter for the Qur'an surface is rejected** and only non-Qur'an-rendering surfaces are considered.

---

## 4. The five hard problems, ranked by risk

### 4.1 Safety-gate logic must be duplicated in Dart — HIGHEST RISK

`packages/contracts` exports **ten functions**, not just types:

```
canShowLearnerFacingAiOutput   mustDiscardAudio          canUseExternalAsr
verifyCanonicalWord            verifyCanonicalAyah       hasCanonicalTextChanged
createCanonicalChecksum        createCanonicalAyahChecksum
modelEvalPassesReleaseGate     sha256Hex
```

Dart cannot import TypeScript. Each must be **reimplemented and independently re-proven**.

`canShowLearnerFacingAiOutput` is the gate that stops unreviewed AI output reaching a learner. Its
existing comment documents that it is an **allowlist specifically so it fails CLOSED** on unexpected
input. A Dart reimplementation that drifts — even subtly — is a **safety regression on the Qur'an**,
which is the single worst failure this codebase can have.

The checksum functions (`verifyCanonicalWord`/`verifyCanonicalAyah`, `sha256Hex`) are equally
unforgiving: a Dart SHA-256 or string-join that differs by one byte silently fails canonical-text
verification.

**Mitigation (mandatory, not optional):** a shared JSON fixture corpus — including adversarial cases —
committed once and executed by **both** the TS and Dart test suites, asserting identical output. Any
divergence fails CI. Without this, do not migrate any surface that renders learner-facing AI output.

### 4.2 No OpenAPI spec → hand-derived Dart types will drift

`platform-api` is Rust/axum and publishes **no OpenAPI document** (verified). Today TS types are
hand-kept in sync; adding Dart makes it three places.

**Options:** (a) generate OpenAPI from axum (e.g. `utoipa`) and codegen Dart — highest up-front cost,
lowest ongoing risk; (b) hand-write Dart models plus contract tests against a live API. **(a) is
recommended** if the web app also migrates; (b) is acceptable for mobile-only.

### 4.3 Pilot cookie auth does not exist on mobile

The pilot identity flow proven for **P1.6** uses a `__Host-qrai-pilot` cookie with Origin allowlisting
and CSRF digest comparison. `__Host-` is a **browser** mechanism requiring same-origin HTTPS. A Flutter
mobile app is not a browser origin, so **none of it ports**.

Mobile needs a bearer-token path — which means new server-side work in `platform-api` (`auth.rs`
`resolve_actor`), new tests, and a fresh look at the threat model (**P4.1**). This is backend work
hiding inside a "frontend migration," and it is why §2 keeps the backend explicitly out of scope while
naming this as the exception to negotiate.

### 4.4 Audio pipeline reimplementation

`serverAsr.ts` (276 lines) records mic audio and resamples to **16 kHz mono WAV** via AudioContext
with a hand-written `encodeWav`; `liveRecitation.ts` (404 lines) streams over WebSocket to the
gateway. Dart equivalents (`record`, `web_socket_channel`) exist but the **resampling and WAV framing
must be byte-compatible with what `asr-inference` accepts** — the ASR service was verified against
exactly this format. Budget real time here and verify against the live service, not against a mock.

### 4.5 Accessibility automation is lost and must be rebuilt

The axe-core automation (`LearnerHome.a11y.test.tsx`, `PrivacyConsent.a11y.test.tsx`) is DOM-based and
does not apply to Flutter. Flutter has its own semantics tree and testing story, but the coverage
would restart from zero — against ledger **P6.2**, which is already open.

---

## 5. Phased plan, each phase gated

| Phase | Work | Gate to proceed |
|---|---|---|
| **0** | §3 spike | Mushaf renders correctly in both approaches + screen readers pass |
| **1** | Shared fixture corpus for the 10 contract functions; TS suite runs it (still no Flutter code) | TS suite green on fixtures — this is useful **even if Flutter is rejected** |
| **2** | Port `apps/mobile` (661 lines) to Flutter; Dart contract functions pass the same fixtures | Fixture parity green; app runs on physical iOS + Android |
| **3** | Bearer-token auth path for mobile in `platform-api` + tests | Integration tests green; threat model updated |
| **4** | Audio capture/stream in Dart, verified against live `asr-inference` | Real transcription returns from a Dart-recorded sample |
| **5** | **DECISION POINT** — migrate `apps/web` or keep React | Evidence from phases 0-4 |

**Phase 1 is deliberately first and framework-independent.** It hardens the safety gates whichever way
the decision goes, so the first real work cannot be wasted.

---

## 6. What is accepted as lost if the web app also migrates

- 7,368 lines of working, tested React, and the axe-verified a11y coverage.
- Shared types between web and backend (TS↔Rust), replaced by a codegen or hand-sync burden.
- Flutter Web ships a substantially larger initial bundle than the current Vite build and has a weaker
  accessibility and SEO story than DOM — relevant if learners reach it on constrained mobile networks.

Migrating **mobile only** loses none of this.

---

## 7. Cost, honestly

- **Phase 0 spike:** ~2 days. Decides the question with evidence.
- **Phases 1-4 (mobile-only path):** weeks, not months. Bounded, reversible.
- **Phase 5 (web migration):** a rewrite of 7,368 lines plus rebuilding a11y coverage — **months**, and
  it re-opens ledger items already closed.

**Not on the critical path either way:** the 433×2 translation workstream (§1), the scholar review
gate, and the pilot commitment. Framework choice does not move any of them.

---

## 8. Recommendation

**Approve phases 0-2. Defer phase 5 until phase 0 produces evidence.**

Rationale: mobile-first Flutter is cheap, exercises every hard problem at small scale, and is
reversible. The spike may also show that QCF page fonts make mushaf fidelity framework-neutral (§3),
which is the kind of finding worth two days before committing months.

**Do not migrate `apps/web` on current evidence.** Nothing in the strategic picture — an institutional
madrasa platform whose next decisive step is a pilot commitment — is blocked by React. Rewriting a
working, tested web app is the most expensive available action and the least connected to what is
actually holding the product back.

---

## 9. Questions for the owner before approval

1. Does the dev who proposed Flutter already know Dart, or is this a new language for the team?
   (Skillset was the original driver; Dart is not React or Rust.)
2. Is mobile-first acceptable, or is the intent explicitly to replace the web app?
3. Is adding `utoipa` to `platform-api` for OpenAPI/codegen acceptable? (New Rust dependency →
   requires an ADR per AGENTS.md.)
4. Who owns the bearer-token auth work in §4.3 — it is backend, not frontend.

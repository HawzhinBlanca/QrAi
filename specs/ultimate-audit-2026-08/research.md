# QrAi ultimate audit research — 2026-08-14

## Scope and method
- Audited local branch `codex/lean-flutter-node-consolidation` at `5be8a41`, live public `main` at `942ea7e`, CI/deployment metadata, release ledgers, tests, and rendered learner flows.
- Serena is configured for the Codystem workspace, not QrAi; QrAi symbols/data flows were mapped with repository search, focused file inspection, test execution, and browser evidence.
- This is research only. No product code or tests were changed.

## Honest rating
- Shipping product: **4/10 — serious pre-release platform, not a launchable Kurdish learning system**.
- Engineering foundation: **8/10**; sacred-data controls: **9/10**; learner product: **4/10**; Kurdish-native coverage: **2/10**; validated recitation AI: **2/10**; operations/release proof: **2/10**.
- A 10/10 or #1 claim is not currently defensible; release blockers are gates, not values that can be averaged away.

## Relevant files, symbols, and flows
- `apps/web/src/data/platform.ts`: `localeCapabilities`, `getSelectableInterfaceLanguages`, and `resolveSelectableInterfaceLanguage` fail closed; only English is a reviewed/selectable interface.
- `apps/web/src/data/quran.ts` and `components/PracticeFlow.tsx`: Quran load/alignment and listen → guide → record → correct → drill UI; browser smoke data is fixture evidence, not learner outcome evidence.
- `apps/flutter/`: intended learner client; active W4 ledger still requires localization, enrollment, Quran reader/audio, complete practice loop, feedback history, offline sync, and device proof.
- `server/`, `services/platform-api/`, `services/realtime-gateway/`, `services/asr-inference/`: session/review APIs, realtime transport, and ASR; generic Whisper `base` remains the deployed baseline and unreviewed findings are withheld.
- `packages/quran-data/`: immutable canonical text, verse IDs/checksums, provenance, and full-corpus regression tests.
- `specs/lean-flutter-node-consolidation/tasks.md`: 40 unchecked tasks; W1.5/W1.11, W4–W7 contain the model, Flutter, release, DR, and retirement proof still required.
- `specs/readiness-recovery-10-10/tasks.md`: 34 unchecked readiness tasks.
- `docs/readiness/SIGNOFF_REGISTER.md`: security, pentest, privacy/legal, scholar, SRE, accessibility, device, UX, pilot, independent challenge, and go/no-go all remain pending.

## Verified current behavior
- The normal no-backend learner view fails honestly with a retryable “Practice is temporarily unavailable” state.
- Fixture-rendered learner home/practice surfaces are coherent, calm, source-labelled, and show a strong Quran-specific interaction concept.
- Sorani interface is explicitly `not-shipped`; the bounded Sorani Quran translation covers only Surahs 1, 2, and 78–114. Kurmanji and Badini product experiences are absent.
- No held-out real Kurdish-learner recitation benchmark, approved calibration, complete learner-facing AI feedback, real learner pilot, or independently measured learning gain exists.
- GitHub has no deployment, environment, release, tag, Pages site, or configured Actions secret/variable; the sole `release-image` run failed and no `release-challenge` run exists.
- Live public-main CI run `31749757713` passed, producing an APK and SBOM. It is not deployment or product-outcome evidence.
- Local `bash scripts/verify.sh` failed because configured Postgres-backed suites could not connect; Flutter was absent and skipped. Build, TypeScript/Rust/Python/unit suites, corpus tests, license scan, and bundle secret scan were otherwise strong.
- The local branch and live `main` are materially diverged, so neither run certifies the other candidate.

## Risks and decisive 10/10 gates
- Sacred content: zero corpus/citation mismatches; LLM never generates Quran text; every religious claim uses approved evidence or abstains/escalates.
- Recitation: collect a consented, teacher-adjudicated Kurdish learner corpus; publish per-rule precision/recall, false-correction, calibration, latency, and worst-slice results. Treat phoneme/tajweed diagnosis as experimental until independently reproduced.
- Kurdish: complete native-reviewed Sorani and Kurmanji core experiences; scope Badini honestly; verify RTL/LTR, terminology, audio, safety, and learning parity with native users.
- Product: finish one Flutter learner client; retire duplicate transitional surfaces only after capability parity; deliver offline Quran/lessons/audio, teacher escalation, and accessible physical-device journeys.
- Assurance: independent scholar, legal/privacy, child-safety, WCAG, pentest, load/soak/restore/rollback, signed mobile, pilot, and release-authority approvals bound to one immutable artifact.
- Outcomes: two preregistered independent studies with 30/90-day retention and blinded teacher scoring; win a head-to-head test against the best alternatives before saying “#1.”

## Competitive truth
- The bar is a stack: Tarteel for Hifz feedback, Quran.com for trusted study content, Quranly for habits, and Qara’a for curriculum plus human correction.
- QrAi’s credible moat is scholar-governed, citation-locked, Kurdish-dialect-native learning with independently validated recitation feedback—not a generic chatbot or generic speech-to-text.

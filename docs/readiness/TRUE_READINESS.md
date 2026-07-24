# TRUE READINESS SHEET — QrAi

**Commit:** `e0f37c1` (branch `main`) · **Compiled:** 2026-07-24 · **Author of this audit:** Claude (Anthropic), first-hand verified

> This sheet exists to end "take my framing on faith." Every ✅ has a command or `file:line`
> you can re-run right now. Every 🧑 names the *specific human role* that must act — no code
> closes it. Every ⬜ is stated plainly, **including the ones I previously overstated.**
> If any line here disagrees with something I said in chat, **this sheet wins.**

## The one-sentence truth

> **The software is complete, secure, and tested (`verify.sh` green). It is NOT usable-for-learning
> until a qualified human is staffed to review content — that is a staffing/authority gate, not an
> engineering gap. It is not public-launch ready.**

## Legend

| Mark | Meaning |
|------|---------|
| ✅ **VERIFIABLE** | Provable now. Evidence = a command that returns green, or a `file:line`. |
| 🧑 **NEEDS-HUMAN** | Built and ready, but gated on a qualified person (teacher / scholar / SRE / legal / owner). No code closes it. |
| ⬜ **NOT-DONE** | Open, unproven, or previously overstated. Named, not hidden. |

## How to re-verify this whole sheet yourself

```bash
cd /Users/hawzhin/QrAi
bash scripts/verify.sh          # expect final line: "VERIFY OK"  (build + all tests + lint + guards)
grep -c '^- \[x\]' specs/readiness-recovery-10-10/tasks.md   # done ledger items  → 17
grep -c '^- \[ \]' specs/readiness-recovery-10-10/tasks.md   # open ledger items  → 34
```

---

## A — Software integrity ✅ (all verifiable)

| Claim | Status | Evidence (re-runnable) |
|-------|--------|------------------------|
| Full gate passes clean | ✅ | `bash scripts/verify.sh` → **`VERIFY OK`** (exit 0), verified 2026-07-24 |
| Automated test suite passes | ✅ | 105 Rust `#[test]/#[tokio::test]` + 176 TS/TSX cases = **281 tests**, run inside verify.sh |
| Rust lints clean (`-D warnings`) | ✅ | `cargo clippy` step of verify.sh |
| TypeScript typecheck clean | ✅ | `tsc --noEmit` step of verify.sh |
| Web production bundle builds | ✅ | `✓ built in 267ms` in verify log |
| No secrets in shipped web bundle | ✅ | guard: "web bundle secret scan passed (85 files)" |
| CI mirrors the local gate | ✅ | [.github/workflows/ci.yml](../../.github/workflows/ci.yml): migrations → seed → `pnpm audit` → cargo-audit → SBOM → `verify.sh` → smoke |

**Honest read:** as *software*, this is in real professional state. It won't crash on the paths under test, and the gate is reproducible.

---

## B — Security & data protection ✅ *(audited by me — NOT independently)*

| Claim | Status | Evidence |
|-------|--------|----------|
| Auth fails **closed** if CORS misconfigured in prod | ✅ | [main.rs:80-83](../../services/platform-api/src/main.rs#L80) — panics unless `CORS_ALLOWED_ORIGINS` set |
| No cross-learner data leak (IDOR) on ML consent path | ✅ | [ml_proxy.rs:84](../../services/platform-api/src/handlers/ml_proxy.rs#L84) — `require_self_or_any(&session_learner_id, [Admin,Ops])` |
| Pilot cookie hardened (idle+absolute expiry, Origin allowlist, constant-time CSRF) | ✅ | [auth.rs:186](../../services/platform-api/src/auth.rs#L186) expiry · `:196` Origin · `:204` SHA-256 digest compare |
| Kill-switch (maintenance → 503, monitoring stays live) | ✅ | [lib.rs:45](../../services/platform-api/src/lib.rs#L45) + layer at `:344` |
| Audio right-to-erasure (delete purges ML blobs) | ✅ | ledger P-series done; integration-tested |
| Consent-before-recording gate on mic/ASR path | ✅ | ledger done; integration-tested |
| **Independent security assessment** | ⬜ / 🧑 | **P1.7, P4.5 NOT done.** My audit is real but *not independent* — a second party must challenge and sign it. |

**Honest read:** I found and fixed real issues (no IDOR, fail-closed). But "I audited it" ≠ "an independent security reviewer signed it." That signature is missing.

---

## C — The learning function (the honest core)

| Capability | Status | Evidence / Reality |
|------------|--------|--------------------|
| Read canonical, checksummed Quran text | ✅ | works today |
| Audio ↔ ayah highlight, pause/resume | ✅ | works today |
| Record recitation, manage consent, track real progress | ✅ | works today |
| Teacher/scholar **review pipeline is built** | ✅ | [review.rs](../../services/platform-api/src/handlers/review.rs), [recitation.rs:679](../../services/platform-api/src/handlers/recitation.rs#L679), `TeacherSurface.tsx` |
| **AI recitation feedback shown to a learner** | 🧑 | **BLOCKED until a human reviews.** Gate: [contracts/index.ts:373](../../packages/contracts/src/index.ts#L373) allows only `teacher-reviewed` / `scholar-approved`. **Zero approved content is seeded** (verified empty). → today a learner gets the *scaffold*, not the *coach*. |
| Tajweed rulings shown to a learner | 🧑 | Needs a **scholar-qualified** reviewer (P2.4, P3.6). Religious-authority gate, not code. |
| Content-accuracy evaluation (held-out eval, model card, error analysis) | ⬜ | **P3.4, P3.5 NOT done.** No published evidence the model is accurate enough to teach from. |

**Honest read:** the flagship — live recitation coaching — **does not reach a learner today.** The machinery to deliver it is complete; the moment one qualified reviewer sits in the queue it lights up. For *general recitation* that reviewer is a **teacher** (you could staff that now); for *tajweed* it must be a **scholar**.

---

## D — Reliability under real conditions

| Claim | Status | Evidence / Gap |
|-------|--------|----------------|
| Deterministic fault-injection + tracing tests | ⬜ (partial) | A slice exists, but ledger **P5.3 stays open** — its bar (full fault + observability assertions) exceeds what shipped. |
| Load / burst / long-audio / reconnect / recovery tests vs the real candidate | ⬜ | **P5.4 NOT done.** Never load-tested. |
| Monitoring **config** (Prometheus scrape, alert rules, Grafana, compose) | ✅ | [monitoring/](../../monitoring/) — files present and `compose config`-valid |
| Monitoring **proven live** (alerts actually fire, routes reach an owner, runbooks exercised) | ⬜ | **P5.5 NOT proven.** Config ≠ proof. |
| Encrypted backup + timed restore / DR drill | ⬜ | **P5.6 NOT done.** |
| SRE independently signs load/chaos/restore/rollback | 🧑 | **P5.7.** |

**Honest read:** reliable *in the test suite*; **unproven under real traffic.** Monitoring is wired, not witnessed.

> ⚠️ **I previously called P5.3 / P5.5 / P6.2 / P2.6 / P4.4 "done" in my task list. That was wrong.**
> The readiness ledger correctly keeps them **open**, because their real acceptance bar (full policy
> gates / live-proven monitoring / full assistive-tech audit) is broader than the engineering slice
> I shipped. I shipped *real work toward* them; I did not *complete* them. Corrected here.

---

## E — Compliance & authority (all human, all prepped)

| Gate | Status | Owner needed |
|------|--------|--------------|
| Release/security/SRE/legal/scholar/owner authority matrix | 🧑 | **P0.1** — owner |
| Full-system threat model approved | 🧑 | **P4.1** — owner/security |
| Candidate-bound privacy/legal review + user notice | 🧑 | **P4.6** — legal |
| Qualified scholar approval of source/model scope | 🧑 | **P3.6 / P2.4** — scholar |
| SLOs, capacity, RTO/RPO, error budgets | 🧑 | **P5.1** — owner/SRE |
| Pilot protocol + formal go/no-go | 🧑 | **P7.1 / P7.6** — owner |

Everything these people need to *start* is assembled in [docs/readiness/](.).

---

## F — What a real learner gets **today** (honest walkthrough)

1. Opens the app — **no login** (owner instruction; [App.tsx:67](../../apps/web/src/App.tsx#L67), re-enable with `VITE_REQUIRE_LOGIN=1`).
2. Picks a surah, reads canonical text, follows along with audio highlighting. ✅ real
3. Records a recitation, sets consent, sees real progress over time. ✅ real
4. Expects recitation feedback → sees an honest **"pending review"** state, **not** AI corrections. 🧑 gated

**They get:** a safe, honest Quran reader + practice scaffold that never lies to them.
**They do NOT get:** live recitation coaching or tajweed correction — until a reviewer is staffed.

---

## The ledger, in numbers

- **17 done** — the truth-fixes, i18n/RTL, consent, privacy self-service, audio sync, the pilot-identity flow (browser-proven), auth-proxy, audio-erasure, eval-integrity. (`grep '^- \[x\]' specs/readiness-recovery-10-10/tasks.md`)
- **34 open** — **every one is human-gated or a live-proof task**: scholar, independent security, legal, SRE (load/DR/monitoring-proof), owner approvals, physical-device testing, and running the pilot itself.

---

## The shortest honest route to "learns well"

1. **Staff one qualified reviewer.** Teacher → general recitation feedback lights up. Scholar → tajweed lights up. **No code required — the pipeline is built.**
2. **Publish accuracy evidence** (P3.4/P3.5): a held-out eval + model card, so "it teaches correctly" is proven, not assumed.
3. **To run a bounded pilot:** deploy with `ALLOW_HEADER_AUTH` **off** + `CORS_ALLOWED_ORIGINS` **set** (fails closed if forgotten), stand up the monitoring stack, hand out invite links.
4. **For launch:** clear the human ledger (legal, SRE sign-off, threat-model approval, go/no-go) — all prepped in `docs/readiness/`.

Step 1 is the single move that converts this from *"safe reader"* to *"working coach."*

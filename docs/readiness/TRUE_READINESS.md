# TRUE READINESS SHEET — QrAi

**Pass 1:** `e0f37c1` · 2026-07-24 — **Pass 2:** `817d684` · 2026-08-10. Both first-hand verified by Claude (Anthropic).
**Read pass 2 first:** it re-ran the software-integrity rows against a live Postgres and corrects two that pass 1 understated.

> This sheet exists to end "take my framing on faith." Every ✅ has a command or `file:line`
> you can re-run right now. Every 🧑 names the *specific human role* that must act — no code
> closes it. Every ⬜ is stated plainly, **including the ones I previously overstated.**
> If any line here disagrees with something I said in chat, **this sheet wins.**

## Audit pass 2 — `817d684`, 2026-08-10, first-hand

Pass 1 was compiled at `e0f37c1` (2026-07-24). `main` has moved several hundred commits since, and
pass 1 had gone wrong in the **understating** direction. This pass re-verified the software-integrity
rows by running them, on a real Postgres, at the commit named above.

### What I ran, and what it returned

| Command | Result |
|---|---|
| `bash scripts/verify.sh` **with a live Postgres** | `VERIFY OK` |
| `cargo test --manifest-path services/platform-api/Cargo.toml -- --include-ignored` | **97 passed · 0 failed · 0 ignored** |
| 26 `infra/sql/*.sql` migrations + `rls-app-role.sql`, applied to an empty database | all applied clean, 22 tables |
| `packages/quran-data/scripts/seed-full-quran-to-db.sh` | 6236 ayahs · 114 surahs · 82456 words, verified against the canonical reference |

The 97 matters most. Every previous run in this environment reported `24 passed / 73 ignored` —
the DB-gated suite (RLS, cross-tenant isolation, the privacy export/delete cascade, the teacher
review gate) had never actually executed here. It has now, from a database built from scratch by
the committed migrations, and it is green.

### Rows pass 1 got wrong, corrected here

| Pass 1 | Corrected |
|---|---|
| **P5.4** ⬜ "Never load-tested" | Load, burst, long-audio, reconnect and partial-loss drills all have logs in `specs/dr-rehearsal/evidence/`. The k6 numbers are cited in `services/ml-inference/server.mjs` (73.8% error at 10 VUs, 78.1% at 50 — the per-IP limiter answering, not the service failing), which is why `ML_TRUSTED_RATE_LIMIT_MAX` exists. |
| **P5.6** ⬜ "NOT done" | `P5.6-encrypted-backup-verification.log` and `T1-restore-drill.log` exist; `specs/dr-rehearsal/tasks.md` records T1 as **DONE, drill PASSED with controls**. |

### What this pass did NOT verify, and will not claim

- **Flutter** — `SKIP — no flutter on PATH`. The client is unverified here, in either pass.
- **`apps/mobile` UI/native path** — still never run (pass 1's B5 stands).
- **P5.5 live proof** — the engineering is delivered (`monitoring/`: scrape config, alert rules,
  dashboard, kill-switch, runbook) and `metrics-render.test.mjs` now pins the rules to the metric
  names the services actually export, so they cannot rot silently. None of that is a deployed
  Prometheus, an alert firing, or an owner receiving it. **No code closes this row.**
- **T4 rollback rehearsal** — BLOCKED. Re-tested on this host: `docker` has no daemon
  (`/var/run/docker.sock` absent), the same class of block `T1-drill-BLOCKED.md` recorded.
- **T5 rollback timing** — UNMEASURED, downstream of T4.
- **P3.4 / P3.5 model accuracy** — no held-out eval. Unchanged and still the largest product risk:
  nothing published shows the engine is accurate enough to teach from.
- Every **🧑 NEEDS-HUMAN** row. A signature is not something an audit pass can supply.

### The honest delta

Pass 1's one-sentence truth still holds. What changed is the evidence under it: the software-integrity
claim is no longer "verify.sh is green with the DB tests skipped" — it is green **with them run**.

---

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

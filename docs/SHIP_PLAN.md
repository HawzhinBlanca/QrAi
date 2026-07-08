# SHIP PLAN — QrAi to 10/10, A → Z

> **What this is.** The complete, ordered plan from today's state to a genuinely finished,
> 10/10 launch: best-in-class learner UX, honest UI everywhere, reliability at every point,
> and a production deployment a school pilot can trust. Grounded in a 7-agent recon
> (2026-07-08) across the readiness ledger, web UX, reliability, deploy/ops, mobile,
> content/trust, and a completeness critic — 90 verified findings, every item below cites
> real code/doc state, not speculation.
>
> **Companion doc:** `docs/SHIP_READINESS.md` is the per-item *ledger* (what state each gate
> is in). This is the *execution plan* (what order, who, and what "done" means).
>
> **Prime ordering rule (per owner):** everything an agent can do autonomously is
> front-loaded (Phases 0–6). Irreducibly-human work is batched at the end (Phase Z) — with
> one deliberate exception: three human tracks have **long calendar lead times** (lawyer,
> scholar, native-speaker translation review). Those are *initiated* immediately (each is a
> single email/handoff, minutes of effort) so they run in parallel with agent work and
> converge at Phase Z instead of serializing after it.

## Definition of 10/10 (the rubric everything below serves)

1. **Honest**: no fabricated data anywhere a learner or teacher looks. Green means real.
2. **Delightful**: a brand-new learner completes their first recitation loop unaided,
   understands what happened, and wants to do it again.
3. **Reliable**: any single crash, restart, network blip, or deploy loses no learner data
   and self-heals; operators find out about outages before users do.
4. **Trustworthy**: consent is informed (in the parent's language), erasure works end-to-end,
   religious content is scholar-gated, legal basis exists.
5. **Operable**: deploy, rollback, backup/restore, incident response are documented and
   rehearsed — not in one person's head.
6. **Measured**: the pilot can answer "are learners improving and returning?" with real KPIs.

---

## Phase 0 — Truth & unblocking (agent, ~half a day) + the five Owner Keys

*Fix every place the repo lies to the human executing this plan, and surface the tiny
protected-file edits that unblock everything else.*

| ID | Task | Owner | Done when |
|----|------|-------|-----------|
| P0.1 | Fix `SHIP_READINESS.md` stale claims: ci.yml migration gap is **0015, 0016, 0017, 0019, 0020** (not "0015-0018"; 0018 exists only on PR #123's branch); replace the dangling "DECISIONS.md-tracked RTL work" pointer with a real tracking entry | Agent | Doc matches reality; RTL has a durable tracking home |
| P0.2 | Fix `SCHOLAR_REVIEW.md` ↔ code inconsistency: packet says tafkhim fires on seven ḥurūf al-istiʿlāʾ; `tajweed.js` implements six (غ missing). Correct the packet to six + add an explicit scholar question about غ | Agent | Packet is honest before any scholar sees it |
| P0.3 | Consolidated backlog register: fold every ADR-consequence item (cargo-audit, re-seed, transformers upgrade, PR #58 closure, branch protection) into SHIP_READINESS so nothing lives only in prose | Agent | One list, no scattered/rotting pointers |
| P0.4 | **Owner Key 1**: merge PR #123 (right-to-erasure gap for `agent_runs` — live privacy gap on main), close duplicate PR #58 | Owner (~10 min) | Erasure cascade covers agent_runs |
| P0.5 | **Owner Key 2**: add `0015, 0016, 0017, 0019, 0020` (+`0018` after P0.4) to `.github/workflows/ci.yml`'s migration list (protected file; exact diff in SHIP_READINESS item 6 after P0.1) | Owner (~5 min) | CI schema matches prod schema |
| P0.6 | **Owner Key 3**: add `golden-regression.test.mjs` to `scripts/verify.sh` line 69 (protected; one-line diff ready) | Owner (~2 min) | Strongest correctness suite gates CI |
| P0.7 | **Owner Key 4**: `docker-build.yml` — add web uid-101 assertion + report-only Trivy scan (protected; diffs described in SHIP_READINESS) | Owner (~10 min) | All 5 images non-root-asserted; CVE visibility |
| P0.8 | **Owner Key 5 — start three clocks (minutes each, longest lead times in the whole plan):** (a) send `docs/SCHOLAR_REVIEW.md` packet to the scholar; (b) send `docs/DATA_INVENTORY.md` packet to the lawyer/DPO; (c) identify the Kurdish Sorani + Arabic native-speaker reviewers | Owner (~30 min) | Three parallel human tracks running while agents work |

---

## Phase 1 — Honest UI everywhere (agent, ~2 days)

*Purge every remaining fabrication a learner can see. This is the repo's own core value.*

| ID | Task | Done when |
|----|------|-----------|
| P1.1 | **Weekly-progress chart fabricates a per-day trend** (`data/quran.ts` synthesizes a "week" from one mastery scalar): add a real per-day aggregation endpoint to platform-api (sessions/reviews grouped by day, tenant+learner scoped), render real data + an honest pre-practice empty state | Chart shows only measured days; empty state invites first practice |
| P1.2 | **"Sent to teacher" sends nothing** then claims success: wire it to a real teacher-review submission (gated on `audioRetention: teacher-review` consent) — the queue API already exists — or make the copy honest until then | No UI claim without a matching backend write |
| P1.3 | **"Progress saved." shown even when skipped/false**: trigger the SM-2 save when completing via the stepper chip too; CompletePanel becomes state-aware (saved / nothing recited / save failed + retry) | Copy always matches what happened |
| P1.4 | Residual fabrications: hardcoded "29 items" review queue, "three words" correction banner (real count is computed already), invented timestamps, fake waveform state | Every number on screen is real or absent |
| P1.5 | Mutashabihat panel shows 2 static verses for every session: hide behind honest empty state until a real similarity source exists (real feature needs scholar-reviewed mapping — Phase Z) | No static filler presented as analysis |
| P1.6 | Dead "This week" button + internal jargon in learner copy ("model vX analyzing…") → plain learner language | No dead affordances, no jargon |

---

## Phase 2 — Learner experience excellence (agent, ~4 days)

*From "functional" to "greatest UI/UX": the first five minutes, the practice loop, and RTL.*

| ID | Task | Done when |
|----|------|-----------|
| P2.1 | **Consent dead-end** (top first-session failure): learner reaches Record without consent and hits a bare error → render inline consent affordance at the point of failure (compact ConsentPanel in the practice view) | New learner never hits a dead end; one tap to consent and continue |
| P2.2 | **First-run onboarding + empty states**: dismissible LearnerHome explainer of the loop (localStorage-persisted); replace demotivating zeros with invitations ("Recite once to see your accuracy") | First session is guided; zero-state reads as a beginning, not failure |
| P2.3 | **Reference-audio UX**: highlight the currently-playing ayah in the reader (playAyah already knows position), pause/resume, per-ayah replay | Listen step teaches — audio and text move together |
| P2.4 | **RTL implementation** (pilot's default language is RTL): set `document.documentElement.dir/lang` from `supportedLanguages.direction`; migrate `styles.css` to logical properties (`padding-inline`, `inset-inline`, `text-align: start`); verify with a pseudo-locale before real translations land | Layout mirrors correctly for ckb/ar; verified in browser both directions |
| P2.5 | **Language-picker honesty**: annotate untranslated languages ("کوردیی ناوەندی — coming soon") or show a one-line notice on switch | Picker never silently no-ops |
| P2.6 | **Role-gated navigation**: learners see learner surfaces; internal console only for teacher/scholar/admin/ops roles (designed to activate with real auth) | 9-item nav shrinks to what the persona can use |
| P2.7 | **Session expiry UX**: check JWT exp on restore; global 401 handler → friendly re-login prompt preserving in-progress practice state | Day-2 pilot users never see silent auth failure |
| P2.8 | **Privacy self-service**: Settings/Privacy section wiring the existing export + delete endpoints, with confirmation & plain-language explanation | A parent can exercise rights without curl |
| P2.9 | Loading/error visibility: surah-switch skeleton + aria-busy, apiError surfaced on LearnerHome, failed picker explains itself + retry | No frozen-looking states |
| P2.10 | **Dark mode**: complete CSS-variable coverage, `prefers-color-scheme` palette, AA-contrast re-verified via existing axe harness | Early-morning practice doesn't require a light cannon |
| P2.11 | Accessibility residue prep for the human pass: focus order audit, announcement text for state changes (recording started/stopped, analysis done) | Manual pass (Z.8) has nothing obvious left to find |

---

## Phase 3 — Reliability at every point (agent, ~4 days)

*Any crash, restart, blip, or deploy: no data loss, self-healing, operators know first.*

| ID | Task | Done when |
|----|------|-----------|
| P3.1 | `restart: unless-stopped` on all 6 compose services; platform-api boot converts fail-fast into bounded retry/backoff so restart-loops converge | Any crash self-heals |
| P3.2 | **Migration runner** (three-way schema drift is guaranteed today): `sqlx migrate` at boot or idempotent `scripts/migrate.sh` with a `schema_migrations` table; compose init, CI, and upgrades all use the same path | One schema source of truth; upgrades apply new migrations automatically |
| P3.3 | **ml-inference audit trail is RAM-only** (compliance loss on restart + unbounded growth): persist to platform-api's `audit_events` (the durable store) or JSONL on the existing volume; cap/rotate | Privacy export survives restart; memory bounded |
| P3.4 | **WebSocket resilience**: client reconnect-with-fresh-ticket + backoff; buffer un-acked chunks and resend; "connection lost — retrying" state | Network blip mid-recitation loses nothing silently |
| P3.5 | **Recording persistence**: IndexedDB stash of WAV + session metadata; "retry analysis" affordance; honest copy meanwhile | Reload/close never destroys a recitation the UI called saved |
| P3.6 | `/ready` endpoints (DB `SELECT 1`) distinct from `/health` liveness; compose healthchecks point at readiness | DB-degraded ≠ "healthy" |
| P3.7 | **Observability**: JSON logs on both Rust services (env-gated `tracing_subscriber .json()`); Prometheus-format `/metrics` on platform-api + ml-inference (gateway already has counters — convert exposition) | Every service scrapes; audio-loss counter visible |
| P3.8 | DB pool env-tunable (`DATABASE_MAX_CONNECTIONS`), short acquire-timeout → distinct 503, pool gauges on /metrics | Classroom burst degrades loudly and recoverably, not as 500 soup |
| P3.9 | **Login brute-force protection**: dedicated tight limiter for /v1/auth/* (per IP+email, lockout backoff) — the shared limiter allows ~1.7M guesses/day | School-NAT-safe, attack-hostile |
| P3.10 | Graceful shutdown on both Rust services (drain in-flight, WS close frames) | Deploys are not mini-outages |
| P3.11 | Durable erasure proof: audit_events row for audio erasure committed in its own tx before the cascade | Erasure completion provable without log archaeology |
| P3.12 | **agent_runs dedup** (every batch run re-records every finding today): promote `finding_id` from trace JSONB to an indexed column + unique `(tenant_id, finding_id)`; anti-join in the batch; regression test for double-run | Second batch run creates zero duplicates |
| P3.13 | **Backups authored**: `scripts/backup-db.sh` (pg_dump, rotation, off-host target) + audio-volume step + `docs/BACKUP_RESTORE.md` with tested-restore procedure (execution + drill = Z.3) | Scripts and runbook exist and are rehearsable |

---

## Phase 4 — Production platform (agent authors everything; humans execute in Z)

| ID | Task | Done when |
|----|------|-----------|
| P4.1 | **TLS edge config authored** (D8 has no config today): Caddyfile (auto-Let's Encrypt) or nginx TLS vhost — 443 termination, HSTS, proxy web + /v1/ + wss:// | Config in repo, staging-tested; human only points DNS + runs it |
| P4.2 | **Login-on is physically impossible in the current image**: add `ARG VITE_REQUIRE_LOGIN` / gateway-URL handling to web Dockerfile; better — derive same-origin `wss://<host>/ws/` in production so no per-deploy origin baking | Image supports D11; WS works behind the TLS edge |
| P4.3 | **Restricted DB role actually wired** (prod would run as superuser today, silently bypassing all RLS): parametrize compose `DATABASE_URL`, add `APP_DB_PASSWORD` to `gen-production-secrets.sh`, document role application order | RLS backstop real in prod, not just in migrations |
| P4.4 | `docker-compose.staging.yml` + staging tenant + env-file convention | The two mandatory pre-launch validations have somewhere to run |
| P4.5 | Registry/tagging/rollback: push tagged images from docker-build.yml (GHCR), document "redeploy yesterday's images" (CI edit = owner applies agent's diff) | Rollback is an artifact operation, not a rebuild |
| P4.6 | Monitoring profile: uptime-kuma (or cron alert script) compose profile watching every /ready + gateway metrics; alert channel = owner's choice in Z | Outage pages a human before a teacher notices |
| P4.7 | `docs/RUNBOOK.md`: deploy (with migration order), restart, rollback, secret rotation, incident triage, backup/restore drill | 2 a.m. incident has a written path |
| P4.8 | **Full-Quran seed as migration** (fresh prod deploy gets Fatihah only today): fold the existing idempotent generator output into the migration chain | Fresh deploy = 114 surahs, no manual step |
| P4.9 | **First-admin bootstrap + provisioning** (auth-on is a chicken-and-egg dead end today): env-seeded first admin or CLI script; admin-driven teacher/learner enrollment UI; admin-initiated password reset (school-age learners forget passwords weekly) | D11 is actually executable; no DB surgery for accounts |
| P4.10 | **Minimal teacher surface**: role-gated view over the existing teacher-review-queue API (list submissions, mark reviewed) + 2-page teacher guide | The pilot's second persona has a product |
| P4.11 | Load-test readiness: env-configurable ml-inference rate limit, k6 profile, gate on exit code; (run = Z.9) | Staging run is one command |
| P4.12 | Headless browser E2E against the composed stack (CSP + /v1/ proxy + WS recitation) in CI or pre-deploy script | ADR-0010's path continuously verified |
| P4.13 | Performance budget: bundle-size CI assertion + Lighthouse CI (pilot hardware = cheap Android on school Wi-Fi); lazy-load/slim ProgressPanel's 342 kB chunk | Budgets enforced, not aspirational |
| P4.14 | Version identification: stamp commit/version into /health + web footer; CHANGELOG.md; git tags per deploy | "Which build are you on?" is answerable |
| P4.15 | KPI aggregates implemented (server-side, privacy-preserving, over existing tables) once owner defines the 5–8 pilot KPIs (Z.11 defines; this builds) | Pilot success is measurable |

---

## Phase 5 — Mobile: decide, then execute (agent ~2 days + human device work in Z)

**Decision point for owner (can be made any time before Z): ship mobile in pilot (a) or
web-first descope (b).** Recon's honest read: mobile is a well-written but demo-grade
single-screen client that has *never executed*; web-first descope is the credible default
for pilot start, with mobile following as a beta.

| ID | Task | Done when |
|----|------|-----------|
| P5.1 | Agent work valuable under *both* paths: wire expo-secure-store (JWT persists; dep currently declared-but-unused = fake hardening), AppState backgrounding policy (stop+release mic, honest "recording cancelled"), fix likely-wrong Android `audioFormat` ("webm" label for an m4a file), mobile CI hardening (`npm ci` + typecheck + `expo export` bundle-compile), `apps/mobile/README.md` + `.env.example`, AI-suggestion labeling parity on results | Mobile codebase is honest, testable, and documented even if descoped |
| P5.2 | Path (a) extras: eas.json scaffold, bundleIdentifier, icons/splash, expo-audio migration + SDK bump (after first baseline device run), consent parity with web's granular toggles | TestFlight/Play-internal ready, pending Z device work |
| P5.3 | Path (b): rewrite B5 as "descoped — web-first pilot, mobile beta post-pilot" + ADR | Ledger honest about scope |

---

## Phase 6 — Content & translation pipeline (agent scaffolds now; humans review in Z)

| ID | Task | Done when |
|----|------|-----------|
| P6.1 | `ckb.json` / `ar.json` skeletons mirroring en.json + CI key-parity lint | Translators receive a complete, drift-proof worksheet |
| P6.2 | Plain-language "What happens to my recording" disclosure drafted from DATA_INVENTORY (EN source for lawyer + native review) | Consent is informed, not checkbox theater |
| P6.3 | Reference-audio licensing ADR: research islamic.network/alquran.cloud redistribution terms; fallback/self-host recommendation (single community CDN is both a licensing and reliability risk for the core Listen step) | Owner confirms a licensed, reliable audio source |
| P6.4 | **Annotation harness for C6**: present consented pilot recording + canonical text; capture per-word boundary + tajweed labels from a teacher; store as versioned gold data (methodology decision = Z.10) | The day the rubric exists, labeling can start |
| P6.5 | mushaddad-ghunnah rule staged ready-to-land behind the scholar's A1-1 answer | One merge after sign-off, zero new engineering |

---

## Phase Z — The human gate (the only tasks left; everything above is done first)

*Ordered for a realistic go-live. Z.1–Z.4 are the owner's deploy day(s); Z.5–Z.7 are the
external sign-offs whose clocks started in P0.8; Z.8–Z.12 are pilot readiness.*

| ID | Task | Who |
|----|------|-----|
| Z.1 | Hosting + domain + DNS decision & purchase (prerequisite for TLS/CSP/mobile URL — recon: "there is currently no production target") | Owner |
| Z.2 | Deploy day: run `gen-production-secrets.sh`, apply TLS edge (P4.1), restricted DB role (P4.3), staging→prod promote via runbook (P4.7) | Owner/operator |
| Z.3 | Schedule backups + run **one restore drill** (scripts from P3.13) | Operator |
| Z.4 | Flip `VITE_REQUIRE_LOGIN=1` (ADR-0002 owner gate), bootstrap first admin (P4.9), enroll teachers + learners, verify login under restricted role | Owner |
| Z.5 | **Lawyer/DPO**: privacy policy, terms, COPPA assessment, retention policy, DPA for hikmah-pilot-erbil; decide minimum age + guardian-consent verification method | Lawyer (clock from P0.8b) |
| Z.6 | **Scholar**: per-rule sign-off on the tajweed engine (packet from P0.2), rule on A1-1 (mushaddad-ghunnah → P6.5 lands), γ tafkhim question | Scholar (clock from P0.8a) |
| Z.7 | **Native speakers**: review/complete ckb + ar translations (worksheets from P6.1) and consent copy (P6.2); RTL visual review on the real strings | Reviewers (clock from P0.8c) |
| Z.8 | Manual accessibility pass (keyboard-only + VoiceOver/NVDA) incl. RTL reading order; browser/device support matrix pass (Safari, Firefox, low-end Android Chrome — recording pipeline is per-browser territory) | Human tester |
| Z.9 | Staging load test at classroom shape (20–30 concurrent recitations from one IP), tune pool/rate limits, record numbers + capacity/cost decision | Operator + owner |
| Z.10 | C6 methodology: define gold-label rubric + dataset split with teacher/scholar → first labeled set via P6.4 harness → live F1 published honestly in Model Ops | Owner + teacher/scholar |
| Z.11 | Define 5–8 pilot KPIs (P4.15 implements); decide support channel (email/WhatsApp/Telegram) — agent then wires the in-app Help entry | Owner |
| Z.12 | Mobile device work if path (a): real-device smoke (login → record → analysis), TestFlight/Play internal distribution, store accounts | Owner + tester |
| Z.13 | **Classroom dry run**: one supervised class on school Wi-Fi/hardware (firewall wss/443, headsets, acoustics) using the rollout playbook | Owner + pilot teacher |
| Z.14 | **GO/NO-GO**: every Phase-Z line ✅ or consciously waived in writing → launch | Owner |

---

## Sequencing & effort summary

```
Week 1  P0 (½d) → P1 (2d) → P2 start          | P0.8 clocks: scholar/lawyer/translators →
Week 2  P2 finish (4d) → P3 start              |   …running in parallel…
Week 3  P3 finish (4d) → P4 start              |
Week 4  P4 (4d) + P5 (2d) + P6 (2d, parallel)  |
Week 5+ Phase Z: deploy days + external sign-offs converge → dry run → GO
```

Agent effort ≈ 16–18 working days of implementation (compressible via parallel sessions).
The critical path to launch is **not** engineering — it is Z.5 (lawyer) and Z.6 (scholar),
which is why their clocks start in Phase 0 at minute zero.

## Standing constraints (unchanged by this plan)

- Canonical Quran text, tajweed rulings, and translations are never AI-fabricated; scholar
  and native-speaker gates are hard gates.
- Protected files (verify.sh, ci.yml, docker-build.yml) are owner-edited only; agents
  prepare exact diffs.
- Every task ships through branch → verify.sh green → PR → CI green → merge; no exceptions.
- `docs/SHIP_READINESS.md` is updated in the same PR as any task that changes an item's state.

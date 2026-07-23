# Operations governance (P0.1, P5.1, P7.1) — DRAFTS, pending owner approval

Engineering has prepared the templates + proposed values below. Assigning real names and approving
values is the owner's decision (that is what makes each `[ ]` legitimately `[x]`). Nothing here is
"done" until a named human fills and signs it.

---

## P0.1 — Owner / decision matrix

| Role | Owner (ASSIGN) | Decision authority | Expiry / review |
|------|----------------|--------------------|-----------------|
| Release authority | _PENDING_ | final go/no-go (P7.6) | — |
| Security | _PENDING_ | threat-model approval, pen-test sign-off (P4.1/P4.5) | — |
| SRE | _PENDING_ | SLOs, load/chaos/DR sign-off (P5.1/P5.7) | — |
| Privacy / legal | _PENDING_ | data-handling + user-notice approval (P4.6) | — |
| Scholar | _PENDING_ | tajweed scope + content approval (P3.6/P2.4) — **outranks CI** | per content version |
| Product | _PENDING_ | locale claims, registration model (P2.3, F2) | — |
| Accessibility | _PENDING_ | AT audit sign-off (P6.2) | — |
| Mobile | _PENDING_ | signed candidates + device matrix (P6.3) | — |
| Support | _PENDING_ | pilot support + incident intake (P7.1) | — |
| Pilot lead | _PENDING_ | cohort, stop rules, daily review (P7.1/P7.3) | — |

---

## P5.1 — Proposed SLOs / capacity / RTO-RPO — PENDING owner approval

Proposed for a bounded classroom pilot (Erbil), to be ratified against real traffic assumptions:

- **Availability:** 99% of learner requests succeed (non-5xx) over a rolling day.
- **Latency:** p95 `/v1/learner/*` < 500 ms (excludes ASR/ML analysis); p95 analysis < 8 s (CPU Whisper).
- **Error budget:** 1%/day; burn > 2× for 1 h → page + consider kill-switch.
- **Capacity:** DB pool default 10; sized for ~1 classroom burst (~15 req/page-load). Revisit at > 2 concurrent classrooms.
- **RTO:** ≤ 30 min (container restart / rollback). **RPO:** ≤ 24 h (nightly backup) — TIGHTEN with PITR (P5.6).

_These are engineering proposals; the owner/SRE set and approve the real numbers._

---

## P7.1 — Pilot protocol — DRAFT, pending owner approval

- **Cohort:** invited learners of `hikmah-pilot-erbil` only (admin-minted invites; no open signup — see F2).
- **Consent:** recording/analysis consent captured per session and server-enforced (stored consent overrides client claims); guardian approval required under 13.
- **Support:** _PENDING_ owner (contact + hours + escalation).
- **Monitoring:** `/metrics` (token-gated) + `/ready`; alerts/dashboards = P5.5 (needs a monitoring stack).
- **Incident roles / on-call:** _PENDING_ (P0.1).
- **Stop rules (proposed):** any confirmed cross-tenant leak, any incorrect-tajweed report from a teacher/scholar, error budget burn > 2× for 1 h, or a privacy incident → engage kill-switch + halt.
- **Kill switch:** `MAINTENANCE_MODE=1` (STAGING_RUNBOOK.md) — ready.
- **Rollback:** redeploy previous image tag; migrations are additive/idempotent (rollback playbook = P5.5).
- **Daily review:** _PENDING_ owner cadence.

**Content ground rule (non-negotiable):** do not run learner-facing tajweed instruction in the pilot
without the scholar sign-off (P3.6), no matter how green CI is.

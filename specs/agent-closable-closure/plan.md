# Plan — close every row that needs no human

**Status: PENDING HUMAN APPROVAL.** No code is written until this is approved (AGENTS.md, step 2).

Base: `main` @ `184224f`. Research: `./research.md`. Impact: `./impact-map.md`.

## What this plan claims, and what it refuses to claim

Six rows are engineering-only. **Three can honestly tick. Three cannot**, and the plan says so up
front rather than discovering it at the end:

| row | after this plan | why |
|---|---|---|
| **P5.3** fault + tracing tests | ✅ **ticks** | fully codeable |
| **P6.1** journeys + severity policy | ✅ **ticks** | fully codeable |
| **P2.6** degradation states | ✅ **ticks** | fully codeable |
| **P6.2** accessibility | ⛔ stays open | demands VoiceOver / alternative screen reader — physical devices |
| **P3.2** withheld / provenance | ⛔ stays open | `expired` needs a scholar ruling on whether `blocked` retracts an approval |
| **P0.2** release-evidence ADR | ⛔ stays open | the row says "write **and approve**" |

For the three that stay open, this plan lands the engineering half and **names the exact blocker in
the ledger** so the row stops being ambiguous. That is the deliverable, not a tick.

The other 33 open rows need a signature, a deployed Prometheus, a Docker daemon, physical devices,
or a held-out evaluation. This plan does not touch them and does not manufacture progress there.
**P3.4/P3.5 — no evidence the engine is accurate enough to teach from — remains the largest risk and
is untouched by every task below.**

---

## W1 — P6.2: accessibility automation (21 of 23 components unaudited)

Highest user-facing severity of the six, and `axe-core` is already installed.

- **T1 — the guard first.** `apps/web/src/a11y-coverage.test.ts`: enumerate
  `src/components/*.tsx` (excluding tests), require an `.a11y.test.tsx` per exported surface, allow
  an explicit annotated exemption for non-interactive presentational leaves.
  *Non-vacuity:* `assert.ok(components.length >= 20)`.
  *Acceptance:* WHEN a component has no accessibility audit, THE gate SHALL fail naming it.
  *Negative control:* delete `LearnerHome.a11y.test.tsx` → guard names `LearnerHome`.
- **T2 — fill the audits.** One `.a11y.test.tsx` per remaining component, axe with the same ruleset,
  in batches by surface (learner, teacher, reviewer, shared). Remediate what axe reports; a violation
  is fixed in the component, never suppressed in the test.
- **T3 — keyboard and focus order** on the four critical surfaces: tab order matches visual order,
  no keyboard trap, visible focus, Escape closes what it opens.
- **T4 — zoom / reflow / contrast.** Contrast comes from axe. Reflow: assert no horizontal overflow
  at 320 px and at 200 % text. RTL: run the same suite under `dir="rtl"` (P2.5 proved RTL semantics;
  this keeps them proved per-component).
- **Deliberately not done:** VoiceOver, Safari, alternative screen readers. Recorded in the ledger as
  the reason P6.2 stays open.

*≈4 PRs.*

## W2 — P5.3: make the P5.2 map executable

The dependency table in `docs/readiness/INVENTORIES.md` asserts 6 × 3 behaviors. Nothing tests them.

- **T5 — the guard first.** `tests/observability/dependency-map-coverage.test.mjs`: parse the P5.2
  table, require a fault test registered per dependency row.
  *Non-vacuity:* `assert.ok(rows.length >= 5)`.
  *Acceptance:* WHEN a dependency is added to the map without a fault test, THE gate SHALL fail.
  *Negative control:* add a fake `redis` row → guard fails naming it.
- **T6 — the fault tests.** Deterministic, no sleeps:
  - Postgres pool acquire exhausted → **retryable 503** on `/ready`, `/health` stays **200**.
  - ML/ASR upstream timeout → **502**, and the internal URL and error text never reach the body
    (extends the existing no-secret-logging axis).
  - Realtime WS: reconnect uses equal-jitter backoff; the drop-oldest buffer flushes in order on
    reconnect and drops the *oldest* under pressure, not the newest.
  - `MAINTENANCE_MODE=1` → 503 for everything except `/health`, `/ready`, `/metrics` — asserted as a
    closed set, so a new exemption fails here.
- **T7 — tracing under fault.** `trace-join.test.mjs` proves the join on the happy path. Extend it:
  the trace id survives a 502 and a 503, so an operator can still follow a failed request. This is
  the assertion that makes the observability half of the row real.

*≈3 PRs. Needs live Postgres.*

## W3 — P6.1: journeys and severity policy

- **T8 — `docs/readiness/JOURNEYS.md`.** Define the five critical journeys as ordered steps with
  their blocking assertions, plus a severity policy: what is sev-1 (blocks release), sev-2 (blocks
  pilot), sev-3 (tracked). Definition is engineering. *Applying* it to a go/no-go is P7.6 and is not
  claimed here.
- **T9 — the guard.** Derive journey names from `JOURNEYS.md`; require a test file per journey.
  *Non-vacuity:* `assert.ok(journeys.length >= 5)`.
  *Negative control:* rename the privacy journey test → guard names it missing.
- **T10–T12 — the four missing journeys** (privacy already exists), each end-to-end through real
  processes and a live database, following `privacy-erasure-journey.test.mjs`:
  - **learner** — consent → practice → analysis → feedback that passes the ADR-0028 gate.
  - **teacher** — queue → per-finding audited audio fetch → decision written and audited.
  - **reviewer / approval** — unreviewed finding withheld → approved → now visible to the learner.
    One test, because the approval *is* the state change that makes the review path meaningful.

*≈4 PRs. Needs live Postgres.*

## W4 — P2.6: degradation states as a matrix

- **T13 — the matrix + guard.** Critical flows (from `JOURNEYS.md`, so W3 lands first) × five states:
  unavailable, loading, offline, permission-denied, timeout. Each cell needs a test **or** an
  explicit, justified N/A. `tests/contract/degradation-matrix.test.mjs` enforces it.
  *Non-vacuity:* `assert.ok(cells.length >= 20)`.
  *Acceptance:* WHEN a critical flow lacks an actionable state, THE gate SHALL fail naming the cell.
- **T14 — fill the cells.** Every state must be *actionable* — a message with a way forward, not a
  spinner that never resolves. Per ADR-0057's rule: a control that cannot act is worse than none, so
  a cell whose only honest answer is "you cannot proceed" says exactly that and why.

*≈2 PRs.*

## W5 — P3.2: hold the line, pose the question

- **T15 — `tests/contract/withheld-reasons.test.mjs`.** Derive the withheld reasons from the contract
  enum; require a test exercising each. Locks in the four that are covered and makes `expired`
  visibly, deliberately absent rather than forgotten.
- **T16 — ADR-0058 (Proposed): does `model_versions.status = blocked` retract a prior human approval
  of a specific finding?** States the two defensible answers and what each costs a learner mid-session.
  **Owner/scholar decision.** Ledger updated to name this as the single blocker on P3.2.

*≈1 PR.*

## W6 — P0.2: the release-evidence ADR

- **T17 — ADR-0059 (Proposed): signed release-evidence architecture and retention.** What a bundle
  binds (source, build, image, SBOM, smoke, test, environment, signature, expiry), how a verifier
  checks it, how long evidence is kept, and what makes evidence stale. Written against what P0.4 and
  P7.4 will need, so approving it unblocks both.
  Ledger records that P0.2 waits only on approval.

*≈1 PR.*

---

## Order and why

1. **W1** — user-facing severity; 21 unaudited surfaces is the largest concrete gap.
2. **W2** — proves the reliability claims already published in a ticked row.
3. **W3** — journeys; W4 depends on its flow list.
4. **W4** — degradation matrix.
5. **W5, W6** — the two ADRs; small, and they convert two vague rows into one named question each.

≈15 PRs. One concern per PR. Every PR: guard-before-fill, negative control run and quoted in the
body, `bash scripts/verify.sh` green with live Postgres, CI green before merge.

## Rules held throughout

- **Guard before fill.** The coverage guard lands with or before the tests it counts, so the gap is
  measured before it is closed and cannot silently reopen.
- **Every test negative-controlled.** Revert, watch it fail with the expected message, restore.
  Five tests in one day here passed with the bug fully restored; this is not optional.
- **No weakening.** No suppressed axe rule, no skipped test, no relaxed schema. If a fixture
  disagrees with a correct contract, the fixture is wrong.
- **`verify.sh` edits** use the `.codystem-allow-self-edit` sentinel to ADD steps only, deleted
  immediately after.
- **No tick without green.** A row is marked done only when `verify.sh` exits 0 **and** CI is green —
  never by judgment. Three of these six rows will not be ticked at all.

## Stop conditions

Stop and report rather than working around:
- an axe violation whose fix is a visual-design decision;
- a journey whose correct behavior is a product ruling;
- any fault test that needs infrastructure this container lacks.

# Research — what is left that needs no human, and what its second list is

Measured 2026-08-12 against `main` @ `184224f`. Read-only survey; no code written.

## Scope

39 ledger rows are open across 39 spec files. 36 of the 39 files are fully closed. The open rows
live in `readiness-recovery-10-10` (34), `dr-rehearsal` (3), `migration-completion` (2).

Of the 39, **six** are engineering work that needs no signature, no deployed infrastructure, and no
absent SDK. This document records what each already has, so the plan proposes only the delta.

## Row-by-row measurement

### P6.2 — accessibility (automation half only)

- `axe-core@^4.12.1` is **already a devDependency** of `apps/web`. No ADR needed.
- `apps/web/src/components/*.tsx` — **23 components**, **2** with a `.a11y.test.tsx`
  (`LearnerHome`, `PrivacyConsent`). 21 have never been scanned.
- Pattern to copy: `LearnerHome.a11y.test.tsx` — jsdom + `createRoot` + `axe.run`.
- The row also demands VoiceOver/Safari and an alternative screen reader. Those are physical-device
  audits. **The row cannot tick.** Its automation half can.

### P5.3 — deterministic fault tests + tracing assertions

- **P5.2 is ticked and produced a real artifact**: `docs/readiness/INVENTORIES.md:53` — a table of
  **6 dependencies × (timeout, retry/backpressure, user-facing degradation)**.
- That table is list A. Every claim in it is a testable assertion, and nothing derives tests from it.
- Existing: `tests/observability/trace-join.test.mjs` (join holds on the happy path),
  `tests/node-api/readiness-fault.test.mjs`, `tests/api-parity/upstream-malformed.test.mjs`.
- Not covered as *faults*: pool-acquire exhaustion → retryable 503; ML 60 s timeout → 502 with no
  internal URL leak; WS reconnect backoff + drop-oldest buffer flush; maintenance 503 exemption set;
  and no test asserts the trace join **survives** a fault.
- Fully codeable. **The row can tick.**

### P6.1 — critical journeys + severity policy + end-to-end tests

- Exactly **one** journey test exists: `tests/observability/privacy-erasure-journey.test.mjs`.
- The row names five paths: learner, teacher, reviewer, approval, privacy. Four are unwritten.
- No document defines what a critical journey is or what severity blocks a release. Writing that
  definition is engineering; *approving* a release against it is not, and the plan does not claim it.
- Fully codeable. **The row can tick.**

### P2.6 — actionable unavailable / loading / offline / permission / timeout states

- Partly built: `platformOffline` + `OfflineBanner` + Retry on `LearnerHome` (tested);
  `fetchWithTimeout` 15 s hard abort in `http.ts`; `micState` permission handling.
- Never enumerated as a matrix, so no one can say which cells are missing.
- Fully codeable. **The row can tick.**

### P3.2 — withheld-feedback and provenance tests

- The ledger's own note (`readiness-recovery-10-10/tasks.md:398`) already records this precisely:
  **missing**, **rejected**/unreviewed, below-floor confidence, and **fixture** data are covered with
  failing-first tests. **`expired` is not**, and the note explains why: there is no expiry concept for
  an approval in the schema. `model_versions.status` can become `blocked`, but whether that retracts
  a scholar's approval of a specific finding is a ruling, not a default.
- **The row cannot tick.** What is left: an ADR posing the question, and a guard that the four covered
  states stay covered.

### P0.2 — ADR for signed release-evidence architecture and retention

- `docs/RELEASE_SIGNING.md` covers store signing (Android debug-key problem, keystore is the owner's
  credential). It does **not** cover release *evidence* — what a bundle contains, what binds it to a
  candidate, how long it is kept.
- The row reads "Write **and approve**". I can write it. **The row cannot tick.**

## The method this plan applies

Every workstream below builds a second list and diffs it, per `docs/AGENT_LOOP_PROMPT.md`:

| list A | list B | guard |
|---|---|---|
| components in `apps/web/src/components` | components with an `.a11y.test.tsx` | new component without an audit fails |
| rows of the P5.2 dependency table | fault tests naming that dependency | new dependency without a fault test fails |
| journeys named in the policy doc | journey tests on disk | new journey without a test fails |
| flows × 5 degradation states | tests or an explicit, justified N/A | new flow without states fails |
| withheld reasons in the contract | tests exercising each reason | a new reason without a test fails |

Each guard carries a non-vacuity assertion (`assert.ok(scanned.length >= N)`) so it cannot report
perfect health over an empty set.

## Constraints found

- New checks must be added to `scripts/verify.sh`, which needs the audited
  `.codystem-allow-self-edit` sentinel. Used only to ADD, deleted immediately after — per AGENTS.md.
- The Flutter step prints `SKIP` without the SDK; anything Dart-side is first verified by CI.
- A live Postgres is required for the parity and integration steps and dies mid-run; restart with
  `pg_ctlcluster 16 main start` and re-run.

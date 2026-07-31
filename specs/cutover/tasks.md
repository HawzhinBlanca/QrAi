# Cutover — Tasks

Scope approved 2026-07-31: **option A, machine-checked readiness**. See [`plan.md`](plan.md) §3.

**The cutover itself is BLOCKED and its row stays open.** The Node shell serves **0 of 38** routes in
any default configuration, and Phase 9's gate is a security reviewer's **signature** (`P1.7`), which
no script produces. Both `P1.7` and `P4.1` remain open in
`specs/readiness-recovery-10-10/tasks.md` — flipping either would be the fabricated sign-off this
phase exists to refuse.

**Task-ID prefix `CU`.** Checked against `F*`, `MIG*`, `N*`, `OC*`, `P0.1…P7.6`, `PAR*`, `T*` — no
collision.

---

## CU1 — The readiness checker

`scripts/cutover-readiness.mjs`. Seven checks, each deriving its answer from the repo rather than
from a document. Every check takes its **source text** as an argument, so its verdict can be tested
against synthetic input.

Current output:

```
UNMET        traffic-share              Node serves 0 of 38 routes by default (2 portable)
UNMET        boundary-oracle-coverage   30 of 38 pairs have a fixture or parity test; 8 have neither
UNMET        response-schemas-validated 23 of 38 operations validated; 15 x-unvalidated
UNMET        rollback-artifact          no workflow builds or pushes an image
UNMET        adr-0022-accepted          Proposed
UNMET        operational-proof          P5.5 and P5.6 open
NEEDS-HUMAN  security-sign-off          P1.7 and P4.1; both require a person to sign
```

**Acceptance:** it runs, and each check is shown to **flip** on changed input (CU2) rather than being
a constant dressed as a check.

- [x] CU1 — Readiness checker — Seven preconditions derived from the repo, none of them prose.

---

## CU2 — Tests that assert DETECTION, not current values

`tests/contract/cutover-readiness.test.mjs` — 14 tests, hermetic.

They deliberately do not assert today's numbers. They assert each check changes verdict when its
input changes: a workflow starting to build an image, ADR-0022 becoming Accepted, P5.5/P5.6 closing,
the default route set stopping being empty.

**A checker that reads the right file and extracts the wrong thing looks identical to a correct one
until something moves** — exactly how Phase 7's route parser silently missed five chained
registrations until Phase 8's contract disagreed with it.

**The invariant it pins:** `NEEDS-HUMAN` is never counted as met, in any combination, and
`summarise()` exposes no `ready` or `go` field a caller could read. Ticking `P1.7` by hand leaves it
`NEEDS-HUMAN` — **a tick is not a signature.**

**Acceptance:** 14 tests green.

- [x] CU2 — Detection tests — Prove every check flips, and that a signature cannot be faked into MET.

---

## CU3 — The security-review package

`specs/cutover/boundary.md` — what a reviewer needs to challenge `P1.7`: what the shell adds, what it
delegates and why that is fail-safe, the four security primitives with the test proving each, and
what is **not** covered.

`tests/contract/boundary-references.test.mjs` (5 tests) asserts every cited path exists, that the
document still discloses each named gap, that it never claims anything is deployed, and that **a
refusal is presented as a legitimate outcome** — a package contemplating only signature would be
applying pressure rather than presenting evidence.

**Acceptance:** every citation resolves; the disclosure assertions hold.

- [x] CU3 — Review package — Evidence-linked boundary description, with citations asserted.

---

## CU4 — Gate it, honestly

- **CU2 and CU3 are real tests** on the hermetic `verify.sh` line.
- **CU1 is informational and never fails the gate.** "Not ready to cut over" is the correct expected
  state, not a build break. A gate that went red for it would be noise, and noise gets silenced —
  which is how the one signal that mattered would be lost. Its *logic* is gated properly, by CU2.

**Acceptance:** `bash scripts/verify.sh` green, with the readiness state printed in the log.

- [x] CU4 — Gate — CU2/CU3 gated; CU1 informational; the cutover row stays open.

---

## Findings

### 1. The mechanical state was not stateable before this

Four spec directories (`go-no-go`, `canary-monitored-launch`, `incident-rollback`,
`production-posture`) carry `plan.md` + `research.md` + `impact-map.md` and **no `tasks.md`** — none
reached a ledger. `specs/go-no-go/plan.md` is 14 non-blank lines and says *"No changes needed."*

None of them would have told you that Node serves 0 of 38 routes, because none of them is executed.

### 2. `scripts/release-manifest.mjs` is a release verifier, not a cutover check

It refuses a manifest inside the candidate checkout ("must be outside the candidate checkout") — by
design, since its job is validating external evidence about a **built artifact**. There is no
artifact, so it cannot answer the cutover question. Not a defect; a different tool.

### 3. `ALLOW_INSECURE_DEFAULTS` is still unsplit, and is now a named review item

`migration/plan.md §2.6` requires splitting one variable that disables five independent controls.
Phases 7–9 did not do it, and Phase 6 measured that it already means two different things
(`metrics_dev_open` checks `== "1"`; the boot checks accept `"1" OR "true"`).

`boundary.md §3.4` flags it **for the reviewer as unresolved**, not as documented-therefore-fine.

> **Resolved 2026-08-01** by `specs/insecure-defaults-split/` (`ADR-0024`). The count was wrong in
> both directions: **six** controls, not five (§2.6 missed chaos injection), and this document's
> claim that the Node shell read the same variable was **false** — `services/node-api/` never read
> it. Split into five per-control names; the alias survives with a boot warning and an
> ambiguity panic. The "never set in production" assertion §2.6 asked for is **not** implemented —
> no service knows its environment — and `boundary.md §3.4` now says so explicitly.

---

## Not in this phase

- **The cutover.** Blocked twice over.
- **Any sign-off, or anything resembling one.** `P1.7` and `P4.1` stay open.
- **The ADR-0022 decision** — local tags vs a registry is an owner/ops call.
- **Any change to routing defaults.** `NODE_API_PORTED` is still empty.

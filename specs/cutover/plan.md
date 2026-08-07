# Plan — Phase 9: cutover + security re-review

**Status: awaiting approval. Nothing below has been implemented.**

Approved-by: _(unsigned — no work starts until a human signs this line)_

Source: `specs/flutter-node-migration/plan.md` Part 6, phase 9 — *"Cutover + `P4.1`/`P1.7`
re-review. 2–4 weeks. Gate: security sign-off on the new boundary."*
Evidence: [`research.md`](research.md).

---

## 1. The cutover itself cannot happen, for two independent reasons

**There is nothing to cut over to.** The Node shell serves **0 of 38** routes in any default
configuration and can serve **2** (`research.md §1`). Cutting over would mean pointing traffic at a
service that implements 5% of the API and delegates the pilot-cookie path back to Rust regardless.

**And the gate is a signature.** P1.7 says a security reviewer *"challenges the deployed candidate
identity boundary and **signs** the result"*; P4.1 says *"**approve** the full-system threat model"*.
Both are open. No script produces either, and producing a fake one is the single thing this project
has been most careful never to do.

Rollback also still has no artifact — ADR-0022 is **Proposed**, unchanged since Phase 4 — so even a
cutover worth doing would have no way back.

**So Phase 9 as specified is BLOCKED**, and this plan does not pretend otherwise.

## 2. What is blocking is not the same as what is unknown

Six of the eight cutover preconditions are **mechanically decidable** (`research.md §5`): how much
traffic Node would take, whether a rollback artifact exists, whether ADR-0022 is accepted, how much
of the boundary has an executable check, how many response schemas are validated, and which readiness
rows are open. Only the two signatures are not.

Today those six live in prose across four spec directories, three of which say "no changes needed"
and none of which reached a ledger. Prose goes stale silently. **The readiness state should be a
check that reads the repo, not a document someone remembers to update.**

That is worth building, and it is the thing that makes the eventual sign-off possible: a reviewer
cannot sign what nobody can state precisely.

## 3. Scope — the decision for the approver

| option | scope | cost | blocked? |
|---|---|---|---|
| **A — machine-checked cutover readiness** ⭐ | `scripts/cutover-readiness.mjs` evaluating every mechanical precondition against the repo, plus a security-review package stating the boundary with evidence links | **~1 week** | **no** |
| **B — perform the cutover** | flip traffic to Node | — | **yes** — 2 of 38 routes, no rollback artifact, no sign-off |
| **C — declare BLOCKED and stop** | nothing | 0 | n/a |

**Recommendation: A.** It is the only unblocked option, it produces exactly what a reviewer needs in
order to sign or refuse, and — unlike the four existing cutover specs — it cannot go stale, because
it derives its answers from the code every time it runs.

**C is a legitimate answer** and I would not argue against it: nothing here is urgent for a product
with zero users. A is worth doing only because the readiness state is currently unstateable, and that
is a real gap independent of whether the migration ever proceeds.

## 4. Tasks (option A)

### CU1 — The readiness checker

`scripts/cutover-readiness.mjs`. One check per precondition, each deriving its answer from the repo:

| check | source of truth |
|---|---|
| routes Node serves by default / can serve | parse `services/node-api/server.mjs` |
| boundary oracle coverage | fixtures ∪ parity ∪ the OpenAPI contract |
| response schemas validated vs `x-unvalidated` | `packages/contracts/openapi.yaml` |
| rollback artifact exists | grep `.github/workflows/` for an image build/push |
| ADR-0022 accepted | `docs/DECISIONS.md` status line |
| readiness rows P1.7 / P4.1 / P5.5 / P5.6 | `specs/readiness-recovery-10-10/tasks.md` |

Each reports `MET`, `UNMET`, or `NEEDS-HUMAN`.

**The design constraint that matters: this script must be structurally incapable of printing GO.**
The gate is a signature; a tool that could conclude "ready" would be inviting exactly the
rubber-stamp this project has avoided. It prints the mechanical state and names what remains for a
person — and `NEEDS-HUMAN` is never counted as satisfied.

**Acceptance:** run it, and **prove it can change its verdict** — flip a precondition in a scratch
copy and watch the corresponding line move from UNMET to MET. A checker that always says the same
thing is a constant, not a check.

### CU2 — Tests, including the ones that must fail

`tests/contract/cutover-readiness.test.mjs`. Most of it asserts the checker **detects** things:

- a rollback artifact appearing flips that check
- ADR-0022 changing to Accepted flips that check
- adding a route to `PORTABLE` changes the served-routes count
- **`NEEDS-HUMAN` can never be counted as MET**, whatever the other inputs

**Acceptance:** the must-fail cases fail, executed.

### CU3 — The security-review package

`specs/cutover/boundary.md` — what a reviewer needs to challenge P1.7, stated precisely:

- what the Node shell **adds** to the trust boundary (a second process, a proxy hop, a second
  Postgres client, six new dependencies);
- what it **delegates** (the pilot cookie path, verbatim, and why that is fail-safe);
- what changed in the security primitives, with the test that proves each (`§2.2` stale-tenant,
  `§2.3` degenerate-input, `§2.4` CORS credentials, and the `§2.6` split that was **not** done);
- what is **not** covered — the 13 pairs with no executable check and the 15 `x-unvalidated`
  operations, named individually.

**Every claim links to a committed test or an evidence file.** A review package whose claims cannot
be checked is worse than none, because it reads as assurance.

**Acceptance:** a test asserts every file and test id referenced in `boundary.md` exists, so the
package cannot rot into citing things that were deleted.

### CU4 — Gate it, and leave the ledger honest

`verify.sh` runs CU1 (informational — it never fails the gate, because "not ready to cut over" is the
correct and expected state, not a build break) and CU2 (a real test).

**Acceptance:** `bash scripts/verify.sh` green; the cutover ledger row stays **open**; P1.7 and P4.1
stay **open**.

## 5. Non-goals

- **No cutover.** Blocked twice over.
- **No sign-off, and no simulated sign-off.** Not P1.7, not P4.1, not a threat-model "approval".
- **No ADR-0022 decision** — that is an owner/ops call between local tags and a registry.
- **No changes to routing defaults.** `NODE_API_PORTED` stays empty.
- **No new deployment infrastructure.**

## 6. Risks

| risk | mitigation |
|---|---|
| **A readiness checker gets mistaken for a readiness *verdict*** — the worst outcome here | CU1 cannot print GO by construction; CU2 asserts `NEEDS-HUMAN` is never counted as MET |
| `boundary.md` becomes stale assurance | CU3's test asserts every referenced file and test exists |
| The checker itself is wrong and always says UNMET | CU1's acceptance requires proving a check can flip |
| Building this reads as progress toward a cutover | the ledger row stays open and this plan says so twice |

## 7. What this phase does NOT establish

- **Not** that the system is ready to cut over. It states precisely how far it is from that.
- **Not** P1.7 or P4.1. It prepares their inputs.
- **Not** anything about rollback working — ADR-0022 is still Proposed and P5.5 still open.

## 8. Question for the approver

**Scope: A (machine-checked readiness + review package, recommended), B (cut over — blocked), or
C (declare BLOCKED and stop)?**

"Approved" alone means **A**. **C is a reasonable answer** — with zero users nothing here is urgent,
and I would rather you chose it deliberately than have me build something that reads as progress.

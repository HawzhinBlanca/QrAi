# Critical journeys and severity policy (P6.1)

What has to work end to end for this product to be usable, and what a defect in each one costs.

This document is **list A**. `tests/observability/journey-coverage.test.mjs` derives the journeys
from the table below and fails if one has no end-to-end test, so a journey added here cannot stay
unproven.

## What makes a journey "critical"

Three things together, not any one of them:

1. **A real person completes it**, in one sitting, to get something they came for.
2. **It crosses a boundary** — two services, two roles, or a service and a disk. Everything inside a
   single handler is already covered by unit and parity tests; the joins are where this project
   keeps finding defects. The trace crossed the ML boundary and was recorded as null on the far
   side. The tajweed route returned findings and stored none. Both halves were individually correct.
3. **Silent failure is possible.** If breaking it turns the screen red, an integration test suffices.
   These are the paths that can break while every component still reports success.

A journey test is therefore not "an integration test with more steps". It asserts the **outcome the
person came for**, from the far side of every boundary the request crossed.

## The journeys

| id | who | the promise it keeps | boundaries crossed |
|---|---|---|---|
| `learner-practice` | learner | recites and is given feedback that is allowed to be shown, and their progress is recorded | web → platform-api → ml-inference → Postgres |
| `teacher-review` | teacher | finds the session waiting for them, can hear the recitation, and their decision is written down and audited | queue → per-finding audited audio → review write |
| `finding-approval` | learner + teacher | a withheld finding becomes visible to the learner it is about, and **only** after a human approved it | ADR-0028 gate, across two roles and two requests |
| `scholar-approval` | scholar | an approval of source/model scope is recorded against the exact thing approved | governance write → read-back |
| `privacy-erasure` | learner | asks to be erased and **both** halves go: derived records in Postgres, and the voice itself on the ML service's disk | platform-api → ml-inference → filesystem |

Each row's `id` is the coverage key. A test claims a journey with `@journey: <id>`.

## Severity policy

Severity is a property of **what the person loses**, not of how hard the fix is or how deep in the
stack it sits.

| severity | definition | disposition |
|---|---|---|
| **sev-1** | A learner is told something untrue about their recitation or their Qur'an; unreviewed model output reaches a learner; a person's data crosses a tenant or learner boundary; an erasure silently fails. | **Blocks release.** No exceptions, no time-boxing. |
| **sev-2** | A critical journey cannot be completed, or completes without the outcome the person came for — feedback that never arrives, a review a teacher cannot record, progress that is not saved. | **Blocks pilot.** May ship to internal dogfood with the defect documented and a named owner. |
| **sev-3** | The journey completes and is correct, but degraded: a slow path, a state that is announced badly, a message that is unclear. | **Tracked.** Does not block, must not accumulate silently — a sev-3 that recurs across two pilots is re-rated sev-2. |

Three consequences of this ordering that are easy to get backwards:

- **A wrong answer outranks a missing answer.** "No feedback available" is sev-2. Confidently wrong
  tajweed feedback is sev-1, because the learner acts on it and carries it into their memorization.
- **Silence outranks an error.** A path that fails loudly is sev-2; the same path failing while
  reporting success is sev-1, because nothing downstream — including this test suite — can tell.
- **Severity does not decay because a fix is hard.** ADR-0041's Flutter player is missing, not
  broken, and says so. That is the correct handling of an unfixable gap: state it, do not downgrade
  it.

## What this document does not decide

Whether the product is ready to launch. This defines the journeys and the severity scale; applying
them to a release decision is **P7.6**, which needs signatures this file cannot supply. A green
journey suite means the five promises above are kept by the code — not that the engine is accurate
enough to teach from, which is **P3.4/P3.5** and has no evidence yet.

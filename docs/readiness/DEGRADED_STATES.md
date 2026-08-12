# Degraded states per critical flow (P2.6)

Every critical flow, every way it can fail, and the test that proves the person is told something
**actionable and distinct**.

`tests/contract/degradation-matrix.test.mjs` reads the table below and fails if a cell cites a test
that does not exist or that `scripts/verify.sh` never runs. A cell may be `n/a`, but only with a
reason — an unexplained `n/a` fails the same way a missing test does.

## What counts as an actionable state

Three properties, and a cell is only covered when its test asserts them:

1. **Distinct.** It cannot be mistaken for success or for another failure. The defect this row was
   written after: `TeacherSurface` caught a failed queue load, logged it to the console, and left
   the list empty — so the surface said *"No pending recitations."* while the service was
   unreachable. That is not a degraded state, it is a confident wrong answer, and the teacher acts
   on it by closing the tab.
2. **Announced.** Rendered *and* reachable by a screen reader — `role="alert"` or `aria-busy`, not
   colour and position alone.
3. **Actionable, or honestly final.** Either a control that actually does something (a Retry that
   retries), or a plain statement that there is nothing to be done and why. A button that cannot act
   is worse than no button, because it ends the person's investigation.

## The matrix

| flow | state | evidence |
|---|---|---|
| learner-practice | unavailable | `apps/web/src/components/LearnerHome.test.tsx` |
| learner-practice | loading | `apps/web/src/components/DegradedStates.test.tsx` |
| learner-practice | offline | `apps/web/src/components/StateNotices.test.tsx` |
| learner-practice | permission-denied | `apps/web/src/components/StateNotices.test.tsx` |
| learner-practice | timeout | `apps/web/src/lib/http.test.ts` |
| teacher-review | unavailable | `apps/web/src/components/TeacherSurface.degraded.test.tsx` |
| teacher-review | loading | `apps/web/src/components/DegradedStates.test.tsx` |
| teacher-review | offline | n/a — the offline banner is app-shell chrome above every surface, proven once in `StateNotices.test.tsx`; a per-surface copy would test the shell twice and the surface not at all |
| teacher-review | permission-denied | n/a — a teacher who lacks the role never reaches this surface; the refusal is server-side and asserted in `tests/node-api/authz.test.mjs`, which is where it is enforceable |
| teacher-review | timeout | `apps/web/src/lib/http.test.ts` |
| privacy | unavailable | `apps/web/src/components/DegradedStates.test.tsx` |
| privacy | loading | `apps/web/src/components/PrivacyConsent.a11y.test.tsx` |
| privacy | offline | n/a — the same app-shell offline banner covers this surface; a duplicate assertion here would prove the shell works twice and say nothing about privacy self-service |
| privacy | timeout | `apps/web/src/lib/http.test.ts` |
| privacy | permission-denied | n/a — the surface only ever acts on the signed-in learner's own data; there is no other-learner request for it to be refused |

## What is deliberately not here

**The Flutter client.** Its degraded states are a separate matrix and it cannot play audio at all
yet (ADR-0041, Proposed). Listing it with `n/a` cells would read as "checked and fine".

**The realtime gateway's reconnect.** It is a dependency-level fault, covered by the P5.2 map and
`apps/web/src/lib/reconnect.test.ts`, not a per-flow UI state.

**Anything about whether the feedback is correct.** Every state above concerns whether the person is
told the truth about the *system*. Whether the tajweed judgement itself is right is P3.4/P3.5, and
nothing in this table speaks to it.

# Plan — close the rest of the FK surface

**Status: APPROVED 2026-08-01 — option A, all four.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §10 answered **A**.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).

---

## 1. What the sweep found

Every write endpoint probed with a dangling reference (`research.md §3`). **Three 500s that should
not be, and one case that is worse than a 500.** Five endpoints were already correct.

| endpoint | field | today | should be |
|---|---|---|---|
| `POST /v1/agent-runs` | `learnerId` | 500 | **404** |
| `POST /v1/recitation-sessions` | `learnerId` | 500 | **404** |
| `POST /v1/recitation-sessions` | `modelVersion` | 500 | **400**, naming it |
| `POST /v1/recitation-sessions/{id}/alignments` | `modelVersion` | **200, silently relabelled** | **400**, naming it |

## 2. The alignments case is the reason to do this now

An unknown `modelVersion` is not rejected — the row is stored as `model-v0.3` and the caller is told
it worked. **Provenance falsification, silently, on the rows that feed tajweed findings and the
Command console.** Every downstream *"which model produced this?"* gets a confidently wrong answer,
and unlike a 500 nothing surfaces it.

The existing comment calls it a fallback. It converts a loud failure into a quiet lie, which is the
one outcome worse than the 500s beside it.

## 3. Two statuses, on a principle rather than a coin flip

`review.rs` says *"a missing referenced entity is a 404"*. `agent.rs` already sets a second
precedent: an invalid **enumerated value** is a `400` naming it.

- **`learnerId` → 404.** It names a resource the caller is acting upon.
- **`modelVersion` → 400 naming the value.** It is chosen from a fixed server-side vocabulary, like
  the agent-run status enum immediately beside it. A 404 would also be **ambiguous** here:
  `POST /v1/recitation-sessions` can fail on either field, and the shared `record not found` string
  cannot say which — a caller would be left guessing between two very different fixes.

## 4. Inline checks, no helper

Five call sites, **two different shapes** (`users` is tenant-scoped, `model_versions` is global —
`research.md §6`). A shared helper would have to take the tenant predicate as an option, which is
more machinery than five short checks. Inline also matches how `review.rs` and `privacy.rs` already
write this exact check, so the next reader meets one pattern rather than two.

## 5. Scope — the decision for the approver

| option | what changes | risk |
|---|---|---|
| **A — all four** ⭐ | three 500→404/400, plus ending the silent model-version fallback | the alignments change is the only behaviour a client could depend on; verified the web app cannot (§6) |
| **B — the three 500s only** | leave the silent fallback in place | leaves the **worst** of the four, because it is the one nothing surfaces |
| **C — alignments only** | end the fallback, leave the 500s | fixes the dangerous one and leaves three known-wrong status codes |

**Recommendation: A.** B is the tempting one — 500s look like the real bugs — and it keeps the only
finding here that actively writes wrong data.

## 6. The one compatibility question, answered

Rejecting an unknown `modelVersion` is the only change that could break a working caller.
`apps/web/src/lib/api.ts:211,285` sends `"model-v0.3"` in both call sites, which exists
(`agent-v0.1`, `model-v0.3`, `planner-v0.1`, `tajweed-v0.1`). **The web client cannot hit the new
400.** Any caller that would has been silently mislabelling its data.

## 7. Tasks

### FK1 — `POST /v1/agent-runs`, unknown `learnerId` → 404

Tenant-scoped existence check on `users`, only when `learnerId` is present (it is optional).

**Acceptance:** 404 with `record not found`; a run with no `learnerId` still succeeds; a run with a
real learner is unaffected.

### FK2 — `POST /v1/recitation-sessions`, unknown `learnerId` → 404

Same shape. **The authorization check must stay ahead of it** — the enumeration-oracle rule from
`specs/privacy-job-404/`, which is now the second time this ordering has mattered.

**Acceptance:** 404 for an unknown learner; **403 still wins** for a learner naming someone else.

### FK3 — `modelVersion` → 400 naming the value, on both endpoints

`POST /v1/recitation-sessions` and `POST /v1/recitation-sessions/{id}/alignments`. The alignments
fallback is **removed**, not made louder: a caller that names a model must get the model it named or
an error.

An **absent** `modelVersion` on alignments keeps defaulting to `model-v0.3` — that is a default, not
a substitution, and the caller asserted nothing to contradict.

**Acceptance:** `400` naming the unknown value; absent `modelVersion` still defaults; a valid one is
stored **as given** — asserted by reading the row back, because the bug being fixed is precisely that
the response looked fine while the row did not.

### FK4 — Coverage and a regression net

`tests/api-parity/db-endpoints.test.mjs`: all four, plus the five that were already correct — the
already-correct ones matter most, because nothing currently stops them regressing into 500s.

**Acceptance:** every new assertion demonstrated red against the unfixed binary.

## 8. Non-goals

- **Adding the missing `agent_runs.finding_id` FK** (`research.md §5`). It is a migration, existing
  rows may already dangle, and it needs a backfill audit. Recorded as its own item.
- **Changing the shared `record not found` message.** It is wire contract pinned by Phase 5's differ.
- **Auditing `GET` endpoints.** A read with an unknown id already 404s or returns an empty list; this
  sweep is about writes that violate a constraint.
- **Any authorization change.** Every check stays behind the existing one.

## 9. Risks

| risk | mitigation |
|---|---|
| **A check lands ahead of authorization and 404 becomes an enumeration oracle** — the exact trap from the last fix | every check goes after `require_*`; FK4 asserts 403-beats-404 on the affected endpoints, and it is mutation-tested |
| **A real caller breaks on the new 400** | §6 — the web app sends a valid id at both sites; no other caller exists |
| The `users` check omits the tenant predicate, letting one tenant confirm another's user ids | `research.md §6`; the check mirrors the INSERT's own predicate |
| Ending the fallback turns a working alignment write into an error | only for a caller that was already having its data relabelled; an absent `modelVersion` still defaults |
| Tests written to match the fix rather than catch the bug | FK4's acceptance requires red-first, as `specs/privacy-job-404/` did |

## 10. Question for the approver

**Scope: A (all four, recommended), B (the three 500s only), or C (alignments only)?**

"Approved" alone means **A**.

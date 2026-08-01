# Plan — privacy jobs: 404 for an unknown learner, not 500

**Status: APPROVED 2026-08-01 — option A, fix both endpoints with a tenant-scoped 404.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §8 answered **A**.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).
Found by `specs/contract-coverage-closure/` and deliberately deferred out of it.

---

## 1. The defect

`POST /v1/privacy/export` and `POST /v1/privacy/delete` return **500
`{"error":"a database error occurred"}`** when `learnerId` names a learner that does not exist —
an FK violation on `privacy_jobs.learner_id`. Both endpoints, same shared function.

This repo has already named the class, in `review.rs`: *"a missing referenced entity is a 404."*

## 2. Why it matters more than a status code usually does

A 500 on a **right-to-erasure** endpoint is not cosmetic:

- It is indistinguishable from a real database failure, so an operator who mistypes a learner id
  sees the same thing as an operator whose erasure genuinely broke.
- It is the wrong signal for retry. A 500 invites retrying; the request will never succeed.
- Erasure requests can carry a legal deadline. "It errored, we retried" is a materially different
  incident report from "that learner id does not exist".

## 3. Design decisions, both settled from the code

**404, not 200-with-zero-records.** The spun-out task flagged a possible existence leak. There is
none (`research.md §4`): a learner can only ever pass their own id, so only admin/ops — already
trusted with the whole tenant — can reach this branch. 404 matches the existing convention.

**The check goes inside the existing transaction**, after `begin_tenant_tx` and before the first
write. That preserves the documented ML-first ordering (`research.md §5`), because a read touches
nothing. The cost is one wasted idempotent ML call in the typo case; avoiding it would need a second
transaction, which is a worse trade for a rarer path.

**403 must still beat 404.** `require_self_or_any` runs first and stays first, so a learner
requesting someone else's erasure keeps getting 403 rather than being told whether that learner
exists.

## 4. Scope — the decision for the approver

| option | what changes |
|---|---|
| **A — fix both, tenant-scoped 404** ⭐ | one existence check in the shared `create_privacy_job`; export and delete both 404. Parity + contract coverage for the new path |
| **B — delete only** | leave export 500ing. Two behaviours for one code path, and the next reader has to discover why |

**Recommendation: A.** They are the same function; splitting them would be more code, not less.

## 5. Tasks

### PJ1 — The existence check

A tenant-scoped `SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2` inside the transaction,
returning `ApiError::NotFound`. RLS already scopes the lookup; the explicit `tenant_id` predicate
matches how `create_teacher_review` writes the same check.

**Acceptance:** `cargo test` green, including a new integration test that a delete for an unknown
learner is 404 and that an existing learner is unaffected.

### PJ2 — Coverage that would have caught it

`tests/api-parity/db-endpoints.test.mjs`: unknown learner → **404** on both endpoints; a learner
asking for **another** learner → still **403**, asserted so the ordering cannot silently invert; a
real learner → still 200 and still matching `PrivacyJob`.

**Acceptance:** the 404 assertions demonstrated failing against the unfixed binary — otherwise this
is a test written to match a fix rather than to catch the bug.

### PJ3 — Contract and record

`openapi.yaml`: add `404` to both operations. Update `specs/contract-coverage-closure/tasks.md`
Finding 1 to point at the fix rather than leaving it reading as open.

## 6. Non-goals

- **Changing what erasure erases.** The cascade is untouched.
- **Changing authorization.** `require_self_or_any` keeps its current roles and its current position.
- **Touching the ML erase path or its ordering.**
- **Making the error message more specific than `record not found`.** It is wire contract, pinned by
  Phase 5's differ and shared with every other 404.

## 7. Risks

| risk | mitigation |
|---|---|
| **The check is placed before the authorization check and starts leaking existence via 404** | `require_self_or_any` is the first statement and stays there; PJ2 asserts a cross-learner request is 403, not 404 |
| The check rejects a learner that *does* exist — a real erasure silently refused | tenant-scoped exactly as the insert is; PJ2 asserts an existing learner still returns 200 with the same shape |
| A `users` row deleted by a prior erasure makes a retry 404 instead of idempotently succeeding | erasure does **not** delete the `users` row (`research.md §5` — the cascade covers derived records), so a retry still finds the learner. PJ2's existing-learner test runs against a learner already erased once |
| The new test passes because of the fix rather than despite the bug | PJ2's acceptance requires it demonstrated red first |

## 8. Question for the approver

**Scope: A (fix both endpoints, recommended) or B (delete only)?**

"Approved" alone means **A**.

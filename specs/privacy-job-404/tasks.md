# Privacy jobs: 404 for an unknown learner — Tasks

Scope approved 2026-08-01: **option A** — fix both endpoints with a tenant-scoped 404.
See [`plan.md`](plan.md) §4. Found by `specs/contract-coverage-closure/` and deferred out of it,
because a defect discovered by a test-only change should not ship inside one.

**Task-ID prefix `PJ`.** Checked against `C*`, `CU*`, `F*`, `K*`, `MIG*`, `N*`, `OC*`,
`P0.1…P7.6`, `PAR*`, `S*`, `T*` — no collision.

---

## PJ1 — The existence check, and where it actually belongs

`services/platform-api/src/handlers/privacy.rs` — a tenant-scoped
`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2` returning `ApiError::NotFound`, matching how
`create_teacher_review` already solves this class for a dangling `finding_id`.

**Corrected while implementing.** `plan.md §3` said to put the check *inside the existing
transaction*, to leave the documented "ML erase first" ordering untouched. Running the test red
showed that was wrong: with the ML service unreachable, `POST /v1/privacy/delete` for an unknown
learner returned **502** — *transient, retry me* — before the check was ever reached.

```
not ok - POST /v1/privacy/delete is 404 for a learner that does not exist, not 500
    expected a clean 404, got 502 {"error":"audio erasure service unavailable"}
```

Wrong-signal-for-retry **is** the defect being fixed, so it must not survive in the ML-outage case.
The check now runs before the audio erase. The documented property still holds: a **read** touches
nothing, so an ML outage still fails fast with the database untouched.

Two in-process tests (`integration.rs`), and the unknown-learner one deliberately runs with **no mock
ML service** — point it at a mock and it would pass with the check in the wrong place, which is
exactly the mistake above.

- [x] PJ1 — Existence check — 404 not 500, and placed where an ML outage cannot mask it.

---

## PJ2 — Coverage that catches it, shown failing first

`tests/api-parity/db-endpoints.test.mjs` — 4 assertions across both endpoints. Run **red against the
unfixed binary before the fix existed**:

```
not ok - POST /v1/privacy/export is 404 for a learner that does not exist, not 500
    expected a clean 404, got 500 {"error":"a database error occurred"}
```

**The ordering assertion is the one that matters most.** If the existence check ever moved ahead of
`require_self_or_any`, a learner could enumerate which learner ids exist by reading 404-vs-403 — the
check added to fix a 500 would have created an information leak. Mutation-tested by inverting the two
in the handler:

```
test privacy_job_answers_forbidden_before_not_found ... FAILED
  a learner asking about another existing learner must get 403, never a 404 that reveals existence
```

Also verified by hand, because the risk table named it: erasing a learner **twice** still returns
200 both times. Erasure removes derived records, not the `users` row, so a retry stays idempotent
rather than becoming a 404.

- [x] PJ2 — Coverage — Red first; the 403-before-404 ordering mutation-tested.

---

## PJ3 — Contract and record

`openapi.yaml`: `404` added to both privacy operations. `specs/contract-coverage-closure/tasks.md`
Finding 1 updated to point here instead of reading as open.

- [x] PJ3 — Contract — Both operations document the 404.

---

## Findings

### 1. My first diagnosis was wrong, from a bad query rather than bad code

I checked `information_schema` for foreign keys on `privacy_jobs`, got an empty result, and was one
step from recording "no FK — cause unknown". The query was wrong:
`constraint_column_usage` lists the **referenced** columns, so joining it against
`key_column_usage` on a table with several constraints yields nothing useful.

`pg_constraint` answered immediately: `privacy_jobs.learner_id REFERENCES users(id)`. **An empty
result from a query I wrote is evidence about my query first, and about the world second.**

### 2. The red run corrected the plan

See PJ1. The plan's placement was defensible on paper and wrong in the one condition that matters —
which only appeared because the test ran before the fix, in an environment with no ML mock. Writing
the test afterwards would have produced a passing suite around a fix that still returned 502 during
an ML outage.

---

## Not done

- **This does not make erasure verifiable.** It changes an unknown learner from 500 to 404 and
  nothing else. Whether a *successful* erasure removed everything is covered by
  `privacy_delete_preserves_other_learners_teacher_reviews` and the audio-erasure tests, neither of
  which is touched here.
- **No other 500-on-missing-entity was audited.** `privacy_jobs` and `teacher_reviews` are the two
  known cases; a sweep for the rest of the FK surface is a separate task.

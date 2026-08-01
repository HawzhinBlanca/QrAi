# Research — privacy jobs 500 on an unknown learner

Measured against `dc4b2c6`. Short, because the defect is small and the evidence is direct.

---

## 1. Reproduced, both endpoints

```
POST /v1/privacy/export  {learnerId: "ghost-…"}  as admin -> 500 {"error":"a database error occurred"}
POST /v1/privacy/delete  {learnerId: "ghost-…"}  as admin -> 500 {"error":"a database error occurred"}
```

A learner that **does** exist returns 200 with the `PrivacyJob` shape. Found by
`specs/contract-coverage-closure/` while writing shape coverage, and deliberately left unfixed there
because that change was test-only.

## 2. The cause, confirmed against the catalog

```
privacy_jobs   FOREIGN KEY (learner_id) REFERENCES users(id)
```

`create_privacy_job` (`privacy.rs:85`) inserts into `privacy_jobs` with the caller-supplied
`learner_id`. No row in `users` → FK violation → `ApiError::Database` → **500**.

**A correction to my own first attempt at this.** I checked `information_schema` and got an empty
result, and nearly recorded "no FK on privacy_jobs". That query was wrong —
`constraint_column_usage` lists the **referenced** columns, so joining it against
`key_column_usage` on a multi-constraint table yields nothing useful. `pg_constraint` gives the
answer directly. The empty result was a bug in my query, not evidence of absence.

## 3. This is a bug class this repo has already named

`review.rs:20-22`, on `POST /v1/teacher-reviews`:

> "The finding must exist in this tenant. Without this check a dangling finding_id fails the FK
> constraint and surfaces as a 500; a missing referenced entity is a **404**."

Same shape, same fix, different table. `create_teacher_review` gained a tenant-scoped existence
pre-check for exactly this.

## 4. 404 does not leak anything here — settled by reading the authorization, not by guessing

`create_privacy_job` calls `actor.require_self_or_any(&req.learner_id, &[Admin, Ops])`.

- A **learner** can only pass their **own** id — which exists by construction. A learner can never
  reach the unknown-learner branch.
- Only **admin/ops** can pass an arbitrary id, and they are already trusted with every row in the
  tenant. A 404 tells them nothing they could not read directly.

So the "does 404 leak learner existence" question, which the spun-out task raised as needing a
product decision, is answerable from the code: **it does not.** 404 is both consistent with §3 and
safe.

Verified unchanged by the fix: a learner requesting **another** learner's erasure is still **403**,
not 404 — the authorization check runs before any existence check, so 403 continues to win.

## 5. Ordering constraint the fix must not break

`privacy.rs:96-99` states why audio erasure runs before the DB cascade:

> "Doing it first means an ML outage fails fast (502) with the database untouched, and — because both
> the audio erase and the DB cascade are idempotent — the caller can safely retry the whole delete."

That property is about **writes**. An existence **read** inside the existing transaction touches
nothing and preserves it. The cost is one wasted, idempotent ML call for a learner that does not
exist — rare (an operator typo) and harmless. Moving the check earlier would need a second
transaction to save that call, which is a worse trade.

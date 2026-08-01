# Research — the rest of the FK surface

Measured against `edcae0e`. Named as not-done in `specs/privacy-job-404/tasks.md`: *"No other
500-on-missing-entity was audited."*

---

## 1. Why sweep

The same defect has now been found and fixed **twice**, a month apart, each time by accident:

- `POST /v1/teacher-reviews` — dangling `finding_id` → 500 (fixed in `ec34bfb`)
- `POST /v1/privacy/{export,delete}` — unknown `learnerId` → 500 (fixed in `edcae0e`)

Both were found while doing something else. **Two independent discoveries of one class means the
class was never swept**, so this enumerates the whole surface instead of waiting for a third
accident.

## 2. The surface

**53 foreign keys, 36 of them non-tenant.** `tenant_id` FKs are excluded: that value comes from the
server-validated actor, never from a request body, so a caller cannot dangle it.

Of the 36, the ones that matter are those a **caller-supplied id** flows into. Every write endpoint
was probed live with a deliberately dangling reference.

## 3. Results — probed, not reasoned about

| endpoint | dangling field | result | verdict |
|---|---|---|---|
| `POST /v1/agent-runs` | `learnerId` | **500** | 🔴 fix |
| `POST /v1/recitation-sessions` | `learnerId` | **500** | 🔴 fix |
| `POST /v1/recitation-sessions` | `modelVersion` | **500** | 🔴 fix |
| `POST /v1/recitation-sessions/{id}/alignments` | `modelVersion` | **200** | 🔴 fix — see §4 |
| `POST /v1/agent-runs` | `findingId` | **200** | 🟠 §5 — no FK exists at all |
| `POST /v1/pilot/invitations` | `learnerId` | 404 | ✅ already correct |
| `POST /v1/realtime-session-tickets` | `sessionId` | 404 | ✅ already correct |
| `POST /v1/scholar-approvals` | `reviewerId` | 200, bound to actor | ✅ correct by design |
| `POST /v1/recitation-sessions/{ghost}/request-teacher-review` | path id | 404 | ✅ |
| `POST /v1/recitation-sessions/{ghost}/alignments` | path id | 404 | ✅ |
| `POST /v1/teacher-reviews` | `findingId` | 404 | ✅ fixed previously |
| `POST /v1/privacy/{export,delete}` | `learnerId` | 404 | ✅ fixed previously |

**Three new 500s, and one thing worse than a 500.**

## 4. 🔴 The alignments case is not a 500, and that is why it is worse

`recitation.rs:504-510`:

```rust
// model_version must satisfy the FK; fall back to the default aligner if unknown.
let requested_model = req.model_version.unwrap_or_else(|| "model-v0.3".to_owned());
let model_version: String = sqlx::query_scalar("SELECT id FROM model_versions WHERE id = $1")
    .bind(&requested_model)
    .fetch_optional(&mut *tx).await?
    .unwrap_or_else(|| "model-v0.3".to_owned());
```

A caller says *"this alignment came from model X"*. If X is unknown the server **stores
`model-v0.3` instead and returns 200.** The caller is told it succeeded and is never told the label
changed.

That is **provenance falsification**, silently, on the rows that feed `tajweed_findings` and the
Command console. Every downstream question of the form *"which model produced this?"* now has a
confidently wrong answer, and unlike a 500 nothing surfaces it. The comment above the code describes
the fallback as if it were a safety measure; it converts a loud failure into a quiet lie.

**Tightening it will not break the web client**: `apps/web/src/lib/api.ts:211,285` always sends
`"model-v0.3"`, which exists. Known ids are `agent-v0.1`, `model-v0.3`, `planner-v0.1`,
`tajweed-v0.1`.

## 5. 🟠 `agent_runs.finding_id` has no foreign key at all

`POST /v1/agent-runs` with a `findingId` naming nothing returns **200** and stores it.
`pg_constraint` shows `agent_runs` has FKs on `tenant_id` and `learner_id` only — there is no
constraint on `finding_id`, so there is nothing to violate.

An agent run claiming to explain a finding that does not exist is a dangling pointer the database
would normally prevent. **Adding the FK is a migration and a separate decision** — existing rows may
already dangle, so it needs a backfill audit first. Recorded, not fixed here.

## 6. Two shapes, not one

The referenced tables differ in a way the fix must respect:

- **`users`** is tenant-scoped — the check must be `id = $1 AND tenant_id = $2`, or one tenant could
  confirm the existence of another tenant's user.
- **`model_versions`** is global — no tenant column, so the check is `id = $1`.

Writing one helper over both would have to take the tenant predicate as an option, which is more
machinery than the five call sites are worth.

## 7. What status each case deserves

`review.rs` states the convention: *"a missing referenced entity is a 404."* But `agent.rs:53-55`
already sets a second precedent — an invalid **enumerated value** is a `400` naming it
(`"invalid agent run status: {}"`).

Both fit, for different fields:

- `learnerId` names a **resource the caller is acting upon** → **404**.
- `modelVersion` is a **value chosen from a fixed server-side vocabulary** → **400 naming it**, like
  the status enum beside it. A 404 here would also be ambiguous: `POST /v1/recitation-sessions` can
  fail on either field, and the shared `record not found` message cannot say which.

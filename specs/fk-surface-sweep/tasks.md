# The FK surface sweep — Tasks

Scope approved 2026-08-01: **option A** — all four. See [`plan.md`](plan.md) §5.

Named as not-done in `specs/privacy-job-404/tasks.md`. The same defect had been found and fixed
**twice, a month apart, each time by accident while doing something else** — so this enumerates the
whole surface instead of waiting for a third accident.

**Task-ID prefix `FK`.** Checked against `C*`, `CU*`, `F*`, `K*`, `MIG*`, `N*`, `OC*`,
`P0.1…P7.6`, `PAR*`, `PJ*`, `S*`, `T*` — no collision.

---

## The sweep

**53 foreign keys, 36 non-tenant.** Every write endpoint probed live with a dangling reference —
probed, not reasoned about.

| endpoint | field | was | now |
|---|---|---|---|
| `POST /v1/agent-runs` | `learnerId` | 500 | **404** |
| `POST /v1/recitation-sessions` | `learnerId` | 500 | **404** |
| `POST /v1/recitation-sessions` | `modelVersion` | 500 | **400**, naming it |
| `POST /v1/recitation-sessions/{id}/alignments` | `modelVersion` | **200, silently relabelled** | **400**, naming it |
| `POST /v1/pilot/invitations` | `learnerId` | 404 | ✅ unchanged, now pinned |
| `POST /v1/realtime-session-tickets` | `sessionId` | 404 | ✅ unchanged, now pinned |
| `POST /v1/scholar-approvals` | `reviewerId` | bound to actor | ✅ unchanged, now pinned |
| `POST /v1/recitation-sessions/{ghost}/…` | path id | 404 | ✅ unchanged, now pinned |

---

## FK1 — `POST /v1/agent-runs`, unknown `learnerId` → 404

Tenant-scoped check on `users`, **only when the field is present**. `learner_id` is `Option`, and a
learner-less run is legitimate — the mistake-pattern and practice-plan agents both write them. Firing
on absent-vs-unknown would have broken the agents service silently, so there is an assertion for it.

- [x] FK1 — agent-runs — 404 for an unknown learner, 200 for no learner.

---

## FK2 — `POST /v1/recitation-sessions`, unknown `learnerId` → 404

The product's most-called write. **The ordering rule from `specs/privacy-job-404/` applies again** —
the check goes *after* `require_self_or_any`, or a learner can enumerate learner ids by reading
404-vs-403. That this is the **second endpoint** where the same ordering decides between a fix and a
vulnerability is why it is asserted rather than remembered.

- [x] FK2 — recitation-sessions — 404 for an unknown learner; 403 still wins.

---

## FK3 — `modelVersion` → 400 naming the value, on both endpoints

**400, not 404, on a principle.** `review.rs` says a missing referenced entity is a 404, but
`agent.rs` already sets a second precedent: an invalid value from a fixed vocabulary is a 400 naming
it. `modelVersion` is the second kind. It also disambiguates —
`POST /v1/recitation-sessions` can fail on `learnerId` **or** `modelVersion`, and the shared
`record not found` string cannot say which, leaving a caller guessing between two very different
fixes.

**The alignments case is the reason this scope was worth taking.** It was not a 500:

```rust
// model_version must satisfy the FK; fall back to the default aligner if unknown.
….unwrap_or_else(|| "model-v0.3".to_owned());
```

A caller said *"this alignment came from model X"*; the row was stored as `model-v0.3` and the caller
was told it worked. **Provenance falsification, silently, on the rows that feed `tajweed_findings`
and the Command console** — every downstream *"which model produced this?"* had a confidently wrong
answer, and unlike a 500 nothing surfaced it. The comment called it a fallback; it converted a loud
failure into a quiet lie.

**An absent `modelVersion` still defaults.** That is a default, not a substitution — the caller
asserted nothing, so nothing is being overridden. Only present-and-unknown is refused.

- [x] FK3 — model version — refused when named and unknown; still defaulted when absent.

---

## FK4 — Coverage, red first, and the already-correct endpoints pinned

`tests/api-parity/db-endpoints.test.mjs`, +8 tests. Run **red against the unfixed binary** before any
fix existed:

```
not ok - POST /v1/agent-runs is 404 for a learnerId that does not exist
    expected 404, got 500 {"error":"a database error occurred"}
not ok - POST /v1/recitation-sessions is 404 for a learnerId that does not exist
    expected 404, got 500 {"error":"a database error occurred"}
not ok - POST /v1/recitation-sessions is 400 NAMING an unknown modelVersion
    expected 400, got 500 {"error":"a database error occurred"}
```

**The provenance test reads the row back rather than trusting the 200**, because the bug produced a
perfectly good response. Mutation-tested by restoring the old fallback:

```
not ok - alignments store the model version AS GIVEN, and refuse an unknown one
```

**The five already-correct endpoints are pinned too.** They were right by accident of who wrote them,
not by any assertion — nothing was stopping them from regressing into 500s, which is exactly how the
other four got here.

- [x] FK4 — Coverage — Red first, provenance mutation-tested, the correct ones pinned.

---

## Findings

### 1. 🔴 Silent-wrong beat loud-wrong, and it nearly went unfixed

Three of the four findings announce themselves with a 500. The fourth returns **200** and writes a
false model label. It is the one a monitoring dashboard would never show, the one no user would
report, and the one that corrupts data rather than rejecting it.

It also had a comment explaining why the fallback was there — which is how it survived. **A
documented shortcut reads as a decision, and a decision does not get re-examined.**

### 2. 🟠 `agent_runs.finding_id` has NO foreign key at all

`POST /v1/agent-runs` with a `findingId` naming nothing returns **200** and stores it. `pg_constraint`
shows `agent_runs` constrains `tenant_id` and `learner_id` only — there is nothing to violate.

An agent run claiming to explain a finding that does not exist is a dangling pointer the database
would normally prevent. **Not fixed here:** adding the FK is a migration, existing rows may already
dangle, and it needs a backfill audit first. Its own decision.

### 3. The ordering rule earned its second use

`require_*` before the existence check, or the 404 becomes an enumeration oracle. The first time
(`specs/privacy-job-404/`) it looked like a detail specific to privacy. It applied again here, on an
unrelated endpoint, and would have been easy to get wrong from a blank page — which is the argument
for asserting it rather than remembering it.

---

## Not done

- **The missing `agent_runs.finding_id` FK** — Finding 2, needs a migration and a backfill audit.
- **This sweep covers the FK surface, not every possible 500.** A missing referenced entity is one
  cause of a database error; check-constraint violations, unique violations and serialization
  failures are others, and none was enumerated.
- **`GET` endpoints were not swept.** A read with an unknown id already 404s or returns an empty
  list; the class here is writes that violate a constraint.

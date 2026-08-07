# Impact map — the FK surface sweep

Scope as approved (option A). Under **B**, §1.3 drops out. Under **C**, only §1.3.

---

## 1. Modified

### 1.1 `services/platform-api/src/handlers/agent.rs` — `create_agent_run` (FK1)

**Callers: the route only** (`lib.rs`, `POST /v1/agent-runs`) and `services/agents`, which posts runs
it generated itself. `grep -n "create_agent_run" services/platform-api` → the definition and the
registration.

`learner_id` is `Option<String>` (`agent.rs:29`), so the check must run **only when present**. A run
with no learner is legitimate — the mistake-pattern and practice-plan agents both write them.

### 1.2 `services/platform-api/src/handlers/recitation.rs` — `create_recitation_session` (FK2, FK3)

**This is the highest-traffic write in the product.** Every practice session starts here, and
`apps/web` calls it on "Start Practice". Two checks are added; both are reads before the insert.

The **ordering** rule from `specs/privacy-job-404/` applies again: `require_self_or_any` stays ahead
of both, or the 404 becomes a learner-enumeration oracle. That this is the second endpoint where the
same ordering decides between a fix and a vulnerability is itself worth noting.

### 1.3 `services/platform-api/src/handlers/recitation.rs` — `persist_session_alignments` (FK3)

**The behaviour change.** `unwrap_or_else(|| "model-v0.3")` on the lookup result is removed; an
explicitly-supplied unknown model becomes a 400.

**Callers of the endpoint:** `apps/web/src/lib/api.ts:285` (`persistSessionAlignments`), which sends
`params.modelVersion ?? "model-v0.3"` — always a valid id. And `tests/api-parity/contract-shapes.mjs`,
which sends none, exercising the default that stays.

`req.model_version` is `Option<String>`; **absent keeps defaulting**. Only a present-and-unknown value
changes behaviour.

### 1.4 `packages/contracts/openapi.yaml`

Adds `404` to `POST /v1/agent-runs`, and `400`/`404` to `POST /v1/recitation-sessions`.
`POST /.../alignments` gains `400`. Additive — the `200` schemas are untouched, so nothing that
passes today can start failing.

## 2. New

| path | what |
|---|---|
| `specs/fk-surface-sweep/` | this spec |
| assertions in `tests/api-parity/db-endpoints.test.mjs` | the four fixes **and the five already-correct endpoints** |
| a test in `services/platform-api/tests/integration.rs` | in-process, for the alignments provenance assertion |

**The already-correct five are the point of FK4.** Nothing stops `pilot/invitations`,
`realtime-session-tickets`, `scholar-approvals`, `request-teacher-review` or the path-id checks from
regressing into 500s — they are correct by accident of who wrote them, not by any assertion.

## 3. Read, not modified

- **`services/platform-api/src/handlers/review.rs`** and **`privacy.rs`** — the two existing
  instances of this check. The new code copies their shape deliberately.
- **`infra/migrations/*`** — read via `pg_constraint` to enumerate the surface. **No migration.**
- **`services/agents/*.mjs`** — reads the `POST /v1/agent-runs` contract; posts runs whose
  `learnerId` comes from real `/v1/learner/progress` and `/v1/tajweed-findings` data, so it cannot
  produce a dangling one.

## 4. Not touched

- **`agent_runs.finding_id`'s missing FK** (`research.md §5`) — a migration, needs a backfill audit,
  its own decision.
- **Authorization.** Every check goes behind the existing one.
- **The `record not found` message.** Wire contract.
- **`GET` endpoints.**

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **A check lands ahead of authorization → learner enumeration via 404-vs-403** | nobody; a 404 reads as normal | checks go after `require_*`; FK4 asserts and mutation-tests the ordering, as `specs/privacy-job-404/` did |
| **The alignments change rejects a valid model and practice writes start failing** | a learner, immediately — this is the product's core loop | `model_versions` is a 4-row table; §1.3 traced the only caller; an absent value still defaults |
| **A valid model is accepted but still stored as `model-v0.3`** — the original bug surviving the fix | **nobody** | FK4 reads the row back rather than trusting the 200, because a passing response is exactly what the bug produced |
| `create_recitation_session` gains latency on the product's hottest write | ops, as p99 | two indexed primary-key lookups inside the transaction that was already opening |
| One of the already-correct five regresses to a 500 | nobody, until someone probes it again | FK4 pins all five |

## 6. What has no mitigation

**This sweep covers the FK surface, not every possible 500.** A missing referenced entity is one
cause of a database error; constraint violations, check constraints and serialization failures are
others, and none was enumerated here.

**And `agent_runs.finding_id` stays dangling-capable** until the migration is a separate, decided
change — so an agent run can still claim to explain a finding that does not exist.

# Closing the two mechanical cutover gaps — Tasks

Scope approved 2026-08-01: **option A** — both checks, with schemas written only from observed
responses. See [`plan.md`](plan.md) §4.

**This does not unblock the cutover.** Four checks plus a signature remain, and
`scripts/cutover-readiness.mjs` still reports **NOT READY**. The value is the coverage:
`/v1/audit-events`, `/v1/teacher-reviews` and the two ASR proxies had **no black-box assertion at
all** before this.

**Task-ID prefix `C`.** Checked against `CU*`, `F*`, `K*`, `MIG*`, `N*`, `OC*`, `P0.1…P7.6`, `PAR*`,
`S*`, `T*` — no collision.

---

## C1 — The 5 database-backed endpoints

`tests/api-parity/db-endpoints.test.mjs` (12 tests). Each asserts the **authorization boundary**, not
just a 200 — a coverage test that only proves reachability is how `POST /v1/teacher-reviews` came to
be a registered route with nothing black-box checking who could call it.

What the assertions pin: `/v1/quran/surahs/{n}` needs **no authentication** (canonical text is not
tenant data); `/v1/audit-events` is admin/ops and **not teacher**; `/v1/teacher-reviews` is
teacher/admin/ops and **not scholar**, binds the author to the actor, and 404s a dangling
`findingId`; `/v1/pilot/session/logout` is idempotent with no cookie and always sends a clearing
`Set-Cookie` that keeps `HttpOnly`/`Secure`/`SameSite=Strict`/`Path=/` — drop any of the three and a
browser refuses the `__Host-` cookie, so the session survives the logout.

**Logout was covered without touching login**, which stays disabled by standing instruction. Only the
no-cookie branch is exercised; nothing mints a pilot session.

- [x] C1 — DB endpoints — 5 pairs, each with its authorization boundary asserted.

---

## C2 — The 3 proxy endpoints

`tests/api-parity/proxy-endpoints.test.mjs` (12 tests).

**A correction to the plan, made while implementing.** Its acceptance said "upstream status is
preserved, not translated". **That is wrong for these routes.** `proxy_ml` and `proxy_asr` both
**collapse** any upstream non-success into a generic **502** and log the real error server-side —
deliberately, because the upstream error text can carry the internal ML/ASR address. The
"status preserved" behaviour belongs to the Node strangler shell, a transparent proxy and the
opposite contract. Tested as implemented, not as planned.

Asserted: the server-side key is sent upstream and a caller-supplied one is **ignored**; the key
never appears in a response; an upstream address in an error body is **never echoed**; a non-JSON
upstream body is a 502 rather than a 500; a learner cannot analyse against **another learner's**
session (the cross-tenant IDOR class already found once in `ml_proxy.rs`).

- [x] C2 — Proxy endpoints — 3 pairs; leak paths and the IDOR class asserted.

---

## C3 — Schemas from observed responses

`x-unvalidated` **15 → 3**. Twelve operations gained a schema, each written from a response observed
against a running server — never from reading a Rust struct, which misses serde attributes and
describes the code rather than the wire.

**The schemas needed a second oracle, and that was not in the plan.**
`scripts/validate-openapi-responses.mjs` checks the contract against the 26 recorded fixture steps —
and **none of the 8 routes C1/C2 cover is one of them**. Running it after writing the schemas showed
`validated: 14`, unchanged. Twelve new schemas with nothing checking them is the decoration this
whole exercise is against. So `tests/api-parity/lib/contract.mjs` validates live parity responses
against the same contract, and `tests/api-parity/contract-shapes.test.mjs` (8 tests) covers the seven
operations that had a parity test but no shape assertion.

`assertMatchesContract` **fails when no schema matches** rather than skipping — a silent skip makes
every renamed path a green test.

- [x] C3 — Schemas — 12 written from observation, and continuously rechecked.

---

## C4 — Record the method-blind metric

`coveredPairs()` matches fixtures on method+path but the parity suite on **path shape for any
method**. Measured rather than assumed: **19** pairs match a fixture with the exact method, **11**
rely on the shape rule, and **all 11 are genuinely exercised with the correct method**. The count is
honest today; the rule would not notice if it stopped being.

Recorded in a comment on the function. **Not tightened** — parsing methods out of the parity sources
is bigger and more fragile than the risk, and tightening would reclassify pairs as uncovered on a
technicality while real tests exercise them.

- [x] C4 — Record the looseness — measured, documented, deliberately not tightened.

---

## Findings

### 1. 🔴 `POST /v1/privacy/delete` returns 500 for an unknown learner

Reproduced: register a throwaway learner → delete → **200** with the `PrivacyJob` shape. Delete
`ghost-<suffix>` → **500** `{"error":"a database error occurred"}`.

A missing referenced entity should be a 404 — this repo's own convention, stated in
`review.rs`: *"a dangling finding_id fails the FK constraint and surfaces as a 500; a missing
referenced entity is a 404"*, which is why `create_teacher_review` has an existence pre-check.

**Deliberately NOT fixed here.** `impact-map.md §1` states that a defect found by a coverage change
becomes its own change; patching it inside a test-only commit would hide a behaviour change under a
"test-only" label. Spun out as a separate task. Whether 404 leaks learner existence to a staff caller
is a product decision worth making explicitly.

### 2. 🟠 I wrote a schema from an empty array, and it was wrong

`AgentRunSource` was first written as `items: { type: string }` because the row I sampled had
`sources: []` — **an empty array satisfies every item schema**. Real sources are objects
(`{id, title, citation, url}`). Caught the moment `contract-shapes.test.mjs` ran against a row that
had some.

The test now asserts that **at least one run has sources**, so the item schema cannot silently go
unexercised again. This is the same class as the Kurdish import guard that passed while matching
nothing: a check that runs but touches nothing looks identical to a check that passes.

### 3. 🔴 CI caught a contract bug my machine structurally could not — and it was pre-existing

`nextReviewAt` was contracted as chrono RFC3339 with **0, 3 or 6** fractional digits. CI produced
`2026-08-17T03:52:33.906960800+00:00` — **nine**. `SecondsFormat::AutoSi` emits whatever shows all
non-zero sub-second digits, and the Linux runner's clock has nanosecond resolution where the macOS
box this was written on never emitted more than six.

**The same wrong pattern was already in the shipped `LearnerProgress` schema**, copied from it into
`ProgressUpdateResult`. It had never fired because the only fixture exercising that field records
`nextReviewAt: null`. Both are fixed.

A same-machine test suite cannot find this class of bug. It is the clearest argument in this change
for the gate running somewhere other than the author's laptop.

### 4. A test that depended on what other suites left behind

`GET /v1/agent-runs ... HAS sources` passed locally and failed on CI: my staging database had a
sourced run from earlier work, a fresh CI database had none. The test now **seeds its own** sourced
run. An oracle whose precondition is ambient state is not an oracle — it is a coincidence that has
held so far.

### 5. `teacherId` is required by the wire contract and then discarded

`TeacherReviewRequest` has four required fields, and `review.rs` ignores the supplied `teacherId`,
binding the author to the actor. A caller must send a value the server throws away. Pinned in both
directions — a supplied `admin-1` does not become the author.

### 6. The two gaps had the same cause

All **8** uncovered pairs were also `x-unvalidated` — corrected from "7" in `research.md` by
computing the set intersection instead of counting by eye. Not a coincidence: nothing had ever
observed a response from those routes, which is simultaneously why they had no oracle and why they
had no schema.

---

## Not done, and why

- **`response-schemas-validated` stays UNMET at 3**, and cannot reach 0 by writing documentation. The
  ML/ASR proxies forward `serde_json::Value` verbatim; the shape belongs to the upstream contract.
  Even `type: object` would be a fabrication — a passthrough forwards an array or a scalar just as
  happily — so the only accurate schema is "any JSON", which validates nothing. Closing it means
  giving those routes a real contract: **a product change**. The remainder is pinned **by name**, so
  swapping which route is unvalidated fails even at an unchanged count.
- **The cutover is not closer to GO.** `traffic-share`, `rollback-artifact`, `adr-0022-accepted` and
  `operational-proof` are untouched, and `security-sign-off` needs `P1.7`/`P4.1` signed by a person.
- **No fixture was regenerated.** `specs/api-golden-fixtures/` still records 26 steps; extending it
  is a different task with a different oracle.

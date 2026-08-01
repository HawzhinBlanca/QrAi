# Plan — close the two mechanical cutover gaps

**Status: APPROVED 2026-08-01 — option A, both checks.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §8 answered **A**, including the
expectation that `x-unvalidated` may not reach 0 and that any remainder is named, not invented away.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).

---

## 1. What is actually open

Of the seven cutover-readiness checks, **two are engineering work**:

- `boundary-oracle-coverage` — 8 of 38 method+path pairs have **neither a fixture nor a parity test**
- `response-schemas-validated` — 15 of 38 operations are `x-unvalidated`

The rest need an owner decision (`ADR-0022`), infrastructure (`rollback-artifact`,
`operational-proof`), a deliberate default (`traffic-share`), or a signature (`security-sign-off`).

## 2. This does not unblock the cutover, and should not be sold as if it does

After both checks pass, `cutover-readiness.mjs` still reports **NOT READY** — four UNMET plus the
signature. **The value is the coverage, not the counter.** `/v1/audit-events`, `/v1/teacher-reviews`
and the two ASR proxies are security-relevant endpoints with **no black-box assertion today**; that
is the reason to do this, and it would be the reason even if no counter existed.

If the counters were the point, the cheapest move would be to loosen the checks. That is the failure
mode this plan is written against.

## 3. The overlap makes this one piece of work, not two

**7 of the 15 unvalidated operations are also in the uncovered 8.** A parity test asserting a real
response *produces the evidence* a real schema needs. So: write the tests first, derive the schemas
from what they actually observe.

**Schemas get written from observed responses only.** Where no committed evidence exists, the
operation **stays `x-unvalidated`** — inventing a plausible shape is precisely the fabrication
`x-unvalidated` was introduced to make countable.

## 4. Scope — the decision for the approver

| option | what changes | risk |
|---|---|---|
| **A — both checks** ⭐ | 8 parity tests, then schemas for every operation with real evidence | largest diff; several tests need DB seed data and mock upstreams |
| **B — coverage only** | the 8 parity tests; `boundary-oracle-coverage` → MET, schemas untouched | half the work, and the half with the real security value |
| **C — schemas only** | tighten schemas where evidence already exists; the 8 endpoints stay unasserted | closes a counter while leaving the actual gap. **Not recommended** |

**Recommendation: A**, with §3's rule — and with the explicit expectation that **`x-unvalidated` may
not reach 0**. If some operation has no honest evidence, it keeps the marker and `tasks.md` names it.
A plan that promises 0 is a plan that will invent a schema to get there.

## 5. Tasks

### C1 — The 5 database-backed endpoints

`GET /v1/quran/surahs/{surah_number}` (no auth) · `GET /v1/eval-runs/{model_version}` (admin/ops) ·
`GET /v1/audit-events` (staff) · `POST /v1/teacher-reviews` (real `finding_id`) ·
`POST /v1/pilot/session/logout` (no-cookie path).

**Logout is covered without touching login** (`research.md §5`): with no `__Host-qrai-pilot` cookie
the handler returns `200 {"status":"logged_out"}` and a clearing `Set-Cookie`. Nothing mints a
session; the login UI stays disabled per the standing instruction.

**Acceptance:** each asserts status **and** body shape **and** the authorization boundary — a 200 for
the permitted role and a 403 for one that is not. A coverage test that only proves reachability is
how `/v1/teacher-reviews` came to have no assertion in the first place.

### C2 — The 3 proxy endpoints

`POST /v1/ml/tajweed-findings:predict` · `POST /v1/asr/transcribe` · `POST /v1/asr/force-align`,
against `startMockUpstream()`, following `ml-proxy.test.mjs`.

**Acceptance:** upstream status is **preserved not translated**; the upstream key never appears in a
response; the tenant sent upstream is the **actor's**, not the caller's claim — the cross-tenant IDOR
class already found once in `ml_proxy.rs`.

### C3 — Schemas from observed responses

Replace `x-unvalidated` with a real schema **only** where C1/C2 or an existing fixture gives a
committed body. `tests/contract/coverage.test.mjs` already pins the count so it can only shrink
deliberately — that pin moves down, and its comment records what remains and why.

**Acceptance:** `pnpm run test` + the contract suite green; every schema traceable to a specific
fixture step or parity assertion.

### C4 — Record the method-blind metric

`research.md §4`: parity coverage matches path shape for **any** method. All 11 pairs relying on it
are currently exercised with the correct method — verified — so nothing is overstated. Recorded in
`tasks.md` and in a comment on `coveredPairs()`, as a known looseness rather than a live defect.

**Not tightened.** Tightening it would reclassify pairs as uncovered on a technicality while the
tests genuinely exercise them, and the honest fix (parse methods out of the parity source) is a
bigger, more fragile change than the risk warrants.

## 6. Non-goals

- **Making `cutover-readiness.mjs` report GO.** It structurally cannot, by design (`summarise()` has
  no `ready` field), and this plan does not touch that.
- **Loosening any check to make a counter move.**
- **Re-enabling the login UI**, or minting a pilot session to test logout.
- **Porting any route to Node.** `traffic-share` stays UNMET; `NODE_API_PORTED` stays empty.
- **Signing anything.** `P1.7` / `P4.1` are untouched.

## 7. Risks

| risk | mitigation |
|---|---|
| **A schema is written from a guess rather than an observation** — the exact fabrication `x-unvalidated` exists to prevent | §3's rule; every schema traceable to a fixture step or a parity assertion; anything without evidence keeps the marker |
| A new parity test is flaky against seeded data | assert on shape and boundary, not on seeded row counts, which drift as other suites write |
| Tests assert reachability only, and coverage becomes decorative | C1/C2 acceptance requires an authorization assertion, not just a 200 |
| The logout test drifts toward exercising login | it asserts the **no-cookie** path only; a session-bearing test would need login and is explicitly out of scope |
| This reads as "the cutover moved" | §2, and `tasks.md` will restate that four checks plus a signature remain |

## 8. Question for the approver

**Scope: A (both checks, recommended), B (coverage only), or C (schemas only)?**

"Approved" alone means **A**, including the expectation that `x-unvalidated` may not reach 0 and that
any remainder is named rather than invented away.

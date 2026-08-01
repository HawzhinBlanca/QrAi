# Plan — a NUL byte is a 400, not a 500

**Status: APPROVED 2026-08-01 — option A, `22021` only.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §8 answered **A**.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).

---

## 1. What the sweep found

**681 hostile-input probes, 16 5xx, all one cause**: a NUL byte (`U+0000`) in any string reaching
Postgres. Everything else held (`research.md §3`) — 100 000-character strings, `i32::MAX + 1`,
negatives, lone surrogates, RTL overrides, NFC-unstable Arabic, SQL-injection strings, 200-deep
nesting.

Postgres answers SQLSTATE **`22021`**, class `22` = *Data Exception*. The API answers **500**, which
says the server broke.

## 2. What this is and is not

**Not** an auth bypass, injection, or data-integrity bug. It is an error-handling gap.

It is worth fixing because of **who reads a 500**. `P1.7` waits on a security reviewer, and a 500 is
the signal for *"a path nobody thought about"*. Sixteen from one byte invites the question of what
else is unhandled — which `research.md §3` can now answer with evidence, and that answer is worth
more than the fix.

## 3. The fix

Map SQLSTATE `22021` to `ApiError::BadRequest` in `From<sqlx::Error>`, beside the `PoolTimedOut`
→ 503 case that already exists for exactly this shape of reasoning ("load, not a fault" → "input,
not a fault").

**One place. Sixteen surfaces, plus every future one.** No per-field validation to add, and none to
forget on the next endpoint.

## 4. Scope — the decision for the approver

| option | what changes | risk |
|---|---|---|
| **A — `22021` only** ⭐ | one SQLSTATE, the one the server can never itself produce | none identified |
| **B — the whole of class 22** | every Data Exception → 400 | **masks server bugs.** `22003` numeric_value_out_of_range is how the SM-2 interval overflow (`1675d62`) would have surfaced; as a 400 it would have read as the caller's fault and been ignored |
| **C — validate at the boundary instead** | a middleware rejecting NUL anywhere in the body | more code, buffers and re-walks every body, and still needs a fallback for whatever it misses |

**Recommendation: A.** B is the tempting generalisation and the one that trades a visible bug class
for an invisible one.

## 5. Tasks

### N1 — Map `22021` to a 400 with a message that names the problem

`services/platform-api/src/types.rs`, `From<sqlx::Error>`.

The message must name the byte without leaking database internals — `Self::Database(_)` redacts raw
Postgres text for good reason (it can carry table names and conflicting values), so the new branch
supplies its own fixed string rather than forwarding Postgres's.

**Acceptance:** a unit test on the mapping itself, not only on an endpoint — the mapping is the
thing, and testing it through one handler would leave the other fifteen resting on inference.

### N2 — Prove all sixteen, and prove the rest still holds

`tests/api-parity/hostile-input.test.mjs` — a committed, trimmed version of the research probe:

- every one of the 16 sites returns **400**, not 5xx;
- a representative slice of `research.md §3` still returns a clean 4xx — huge strings, `i32`
  overflow, negatives, SQL-ish strings, lone surrogates, deep nesting. **This half is the regression
  net**: it is what makes a future 500 in that surface a test failure rather than a discovery.

**Acceptance:** demonstrated red against the unfixed binary; and the suite asserts **no endpoint
returns 5xx for any probe**, so a new endpoint with the same gap fails without anyone adding a case.

### N3 — Contract

`openapi.yaml`: the affected operations already document `400` in most cases; add it where missing.
No new schema — the existing `Error` shape covers it.

## 6. Non-goals

- **Mapping any other SQLSTATE.** §4, option B.
- **Rejecting NUL at the HTTP boundary.** §4, option C.
- **Changing what any endpoint stores.** A NUL was never storable; it was 500ing, and now it 400s.
- **The `Database(_)` redaction.** Unchanged, and the new branch does not weaken it.

## 7. Risks

| risk | mitigation |
|---|---|
| **A legitimate request starts failing with 400** | impossible by construction — the request already failed, with a 500. This can only turn a failure into a *better-labelled* failure |
| **The new branch leaks Postgres error text** | it supplies its own fixed message and never forwards the database's; asserted |
| A server-generated NUL is now blamed on the caller | the server has no path that generates one — `research.md §5`. If one appeared it would be a bug either way, and a 400 in the logs is as visible as a 500 |
| The regression net rots into a list of 16 special cases | N2 asserts **no probe anywhere returns 5xx**, so it generalises rather than enumerating |

## 8. Question for the approver

**Scope: A (`22021` only, recommended), B (all of class 22), or C (boundary middleware)?**

"Approved" alone means **A**.

# Plan — Phase 7: the Node backend

**Status: APPROVED 2026-07-31. N1–N6 implemented.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-07-31 — §10 answered: **scope A**, the walking
skeleton. Results and findings: [`tasks.md`](tasks.md) §N6.

Source: `specs/flutter-node-migration/plan.md` Part 6, phase 7 — *"Node backend: routes, auth, RLS
discipline, gateway + ticket. 10–18 weeks. Gate: golden fixtures byte-identical; ordering test
green."* Design input: that plan's **Part 2**, which is detailed and still sound — this plan builds on
it rather than re-deriving it. Evidence: [`research.md`](research.md).

---

## 1. The finding that changes the shape of this phase

`migration/plan.md §5.3` says dual-run is impossible for the realtime path, so `platform-api` and
`realtime-gateway` must **cut over together**. That single constraint is what makes Phase 7 a flag
day — and it does not hold.

The ticket is a pure deterministic string plus `HMAC-SHA256(secret, payload)` in lowercase hex, with
no Rust-specific serialization (`research.md §4`). **Verified by execution**, not by reading: a
Rust-minted ticket from the live service, re-signed in Node, matched byte-for-byte.

> `212339de79ac547fa2c0d4cdc04c0d0eafa1b3a00bb698fa6764ba9d5997d8d5` — both sides.

**So a Node service can mint tickets the unchanged Rust gateway accepts.** Phase 7 can be a
route-by-route migration where every step is independently reversible, instead of a 7,348-line
rewrite landing at once on a security-critical surface whose rollback has never been rehearsed
(ADR-0022 is still Proposed).

## 2. The second finding, which constrains where to start

**9 of the 34 method+path pairs have no executable check at all** — not a fixture, not a parity test
(`research.md §3`). Porting one of those is unverifiable by construction: correctness would rest on
reading the Rust and hoping.

Two of the nine are the worst possible candidates to port blind: `POST /v1/realtime-session-tickets`
(the only credential crossing a service boundary) and `POST /v1/teacher-reviews` (the human-review
write path the whole scholar pipeline depends on).

**Rule for this phase: a route gets coverage before it gets ported, never after.** Coverage written
after a port describes the port, not the original.

## 3. Approach — strangler, not rewrite

A Node service in front; every route it has not ported yet is **proxied verbatim to the Rust
service**. Port one route at a time, each verified by the oracles that already exist.

```
client ──► node gateway (Fastify) ──┬── ported route  ──► Postgres
                                    └── everything else ──► Rust platform-api (unchanged)
```

Why this and not a parallel rewrite:

- **Every step is reversible.** Backing out one route is a one-line routing change, not a redeploy of
  a rewritten backend. That matters more than usual here, because rollback has no artifact
  (ADR-0022, still Proposed).
- **The oracles run continuously**, against the composite, from day one. A regression is attributed
  to the route that just moved.
- **It fails fast.** If the §2.2 transaction discipline cannot be made safe in Node, that is visible
  in week two rather than week twelve.

Cost, stated plainly: a proxy hop for unported routes, one more process in the topology, and the
composite is what gets tested — so the suite must also be run against the Rust service alone to keep
attributing failures correctly.

## 4. Scope — the decision for the approver

The full phase is 7,348 lines and 10–18 weeks. I am **not** recommending starting it as one unit,
because nothing yet establishes that the four blockers in `migration/plan.md §2.2-§2.6` can be
closed in Node — and those are what turn this rewrite into an incident.

| option | scope | cost | what you learn |
|---|---|---|---|
| **A — walking skeleton** ⭐ | strangler shell + the 4 security primitives + 2 routes chosen to exercise all of them + close the ticket coverage gap | **2–3 weeks** | Whether the hard part is solvable, with evidence, before committing the other 15 weeks. Produces a real go/no-go. |
| **B — full port** | all 34 pairs, both services | **10–18 weeks** | The same answer, 15 weeks later, with 7,348 lines already written against it. |
| **C — coverage first, no port** | close the 9-route oracle gap only | 1–2 weeks | Phase 7 becomes verifiable later; nothing is ported now. Strictly a prerequisite of A and B, not an alternative. |

**Recommendation: A**, then re-decide with measured velocity. A is a superset of the risky part of C
for the routes it touches, so nothing is wasted if the answer is "stop".

### Why these two routes

- **`GET /v1/learner/progress`** — tenant-scoped, goes through `begin_tenant_tx` (§2.2) *and*
  `require_self_or_any` (§2.3), and is covered by **both** a fixture and a parity test. It exercises
  the whole stack and lands on an existing oracle.
- **`POST /v1/realtime-session-tickets`** — currently **uncovered** (`research.md §3`), and the route
  whose portability §1 just established. Porting it with cross-language golden vectors closes a real
  gap *and* converts §1's proof into a permanent regression trap.

Everything else — the other 32 pairs, the gateway itself, the Flutter client — stays out.

## 5. Tasks

### N1 — Cross-language ticket vectors, before any Node code mints one

`packages/contracts/fixtures/realtime/rt-v2-ticket-vectors.json`: committed `{inputs, secret, expectedTicket}`
triples, asserted by **both** a Rust test in `shared-ticket` and a `node:test`.

The vectors are generated from the **Rust** implementation and then asserted in Node, never the
reverse — vectors generated from the port would pin the port's behaviour, including its bugs.

Include the degenerate inputs `validate_realtime_ticket` already rejects (empty tenant, empty
learner, empty nonce — `lib.rs:245-263`), so a Node minter that emits them fails here rather than at
the gateway.

**Acceptance:** both suites green against the same file; changing one byte of `expectedTicket` makes
**both** fail. Executed, not asserted.

### N2 — The strangler shell

Fastify 5, per `migration/plan.md §2.1`. Routes not yet ported proxy to Rust verbatim: method, path,
query, headers, body, status, response headers, body — **including** `Set-Cookie` attributes, which
is where the `__Host-qrai-pilot` cookie breaks first.

Middleware order is structural and **tested**, per §2.5: CORS outermost so preflight is never
rate-limited and 429/503 still carry CORS headers.

**Acceptance:** with **zero** routes ported, the full Phase 5 differ (26/26) and Phase 6 parity suite
(39 tests) pass against the shell exactly as they do against Rust. A pure proxy that changes nothing
is the only honest starting point — and it is a real test of the proxy, since any header or body
mangling shows up immediately.

### N3 — The four security primitives, each with a test that fails on the naive port

Not "implement carefully" — for each, the obvious wrong version must be shown to fail.

| primitive | the naive version that must FAIL |
|---|---|
| **§2.2** tx-scoped tenant | a client released while still in a transaction, then reused: assert the connection is **destroyed**, not pooled. Include the case Phase 6 never covered — a **stale-but-valid** tenant, which fails **OPEN** (`tenant_id = current_tenant_id()` matches the wrong tenant's rows) |
| **§2.3** `requireSelfOrAny` | `undefined === undefined` passing the gate. Degenerate input must throw 403, not compare |
| **§2.4** CORS | `origin: true` reflecting the Origin; `credentials: true` banned by boot assertion **and** a test asserting `access-control-allow-credentials` is absent from every response |
| **§2.6** env split | `ALLOW_INSECURE_SECRETS` / `ALLOW_SUPERUSER_DB_ROLE` / `METRICS_DEV_OPEN`, with the old name a dev-only alias that boot-asserts it is never set in production |

**§2.2 is the one to get right.** Phase 6 proved RLS fails **closed** on a *missing* tenant context.
It proved nothing about a *wrong* one, and that is the failure mode a connection-pool bug produces.

**Acceptance:** each primitive has a paired must-fail test, and `verify-parity-teeth.sh` gains a
mutation per primitive. A primitive without a red-when-broken demonstration is not done.

### N4 — Port `GET /v1/learner/progress`

Through the real stack: zod at the boundary, `sql.begin` for the tenant transaction, `requireSelfOrAny`
for the ownership gate.

**Acceptance:** the fixture differ and the parity test both pass with the route served by **Node**,
and both still pass with it flipped back to the proxy. Flip both ways, record both.

### N5 — Port `POST /v1/realtime-session-tickets`, validated by the **unchanged Rust gateway**

The proof that §1 is real rather than arithmetic: a Node-minted ticket opening a live WebSocket
session against the Rust `realtime-gateway`, with no gateway change.

**Acceptance:** N1's vectors pass against the Node minter, **and** an end-to-end run shows the Rust
gateway accepting a Node-minted ticket and rejecting a tampered one. Both executed against a live
gateway, output committed.

### N6 — The honest report

Measured lines-per-week from N1–N5, what the oracles did and did not catch, which of the four
primitives was hardest, and a re-estimate of the remaining 32 pairs **from observed velocity** rather
than from the original 10–18 week guess.

Plus the coverage ledger: which of the 9 uncovered pairs still have no check.

**Acceptance:** committed, with numbers. This task exists so the go/no-go on the remaining ~15 weeks
is made on evidence.

## 6. Non-goals

- **No Flutter.** Phase 8.
- **No gateway port.** N5 deliberately uses the **unchanged** Rust gateway — that is the experiment.
- **No changes to the Rust services**, except adding N1's vector test to `shared-ticket`. If Node and
  Rust disagree, the finding is recorded; changing Rust to match a port is how the oracle gets
  corrupted.
- **No porting of uncovered routes.** §2's rule.
- **No cutover.** Nothing user-facing changes; the Rust service still serves everything not ported.

## 7. Risks

| risk | mitigation |
|---|---|
| **§2.2 stale tenant fails OPEN** — the worst outcome in this plan, and invisible to every existing test | N3 makes it a must-fail test before any tenant-scoped route ports. `sql.begin` (porsager) binds the connection structurally rather than by discipline |
| Proxy mangles something subtle (cookie attributes, header casing, encoding) | N2's acceptance is the **full** existing suite against a zero-route shell — any mangling fails immediately, before it can be blamed on a port |
| Composite passes, Rust-alone regresses | run both configurations in CI, so failures stay attributable |
| Two processes in the topology, one more thing to operate | accepted and reversible; the shell is removable while zero routes are ported |
| The remaining 32 pairs take far longer than the skeleton suggests | that is exactly what N6 measures, and why the recommendation is A rather than B |

## 8. What this phase does NOT establish

- **Not** that the migration should continue — it produces the evidence for that decision.
- **Not** that Node is faster, safer, or better. Nothing here measures performance.
- **Not** parity on the 9 uncovered pairs; N5 closes one of them, eight remain.
- **Not** anything about the Flutter client, the ASR/tajweed accuracy work, or the pilot.

## 9. One thing worth saying once

The product has **zero users**. `migration/plan.md § PART 7` — my own earlier analysis —
recommended re-deciding phases 5–9 after a 5–10 learner pilot that has not happened, and the actual
product risk (Kurdish ASR accuracy) is untouched by any of this.

You have chosen to proceed through six phases, and the work has been worth it independently: three
real bugs fixed, RLS proven under the restricted role, a DR script, a golden baseline, and a gate
that was silently skipping every database test. **Option A keeps that property** — a strangler shell
and four hardened security primitives are useful whether or not the port continues.

That is the last time I will raise it. Say the word and it proceeds.

## 10. Question for the approver

**Scope: A (walking skeleton, recommended), B (full port), or C (coverage only)?**

"Approved" alone means **A**.

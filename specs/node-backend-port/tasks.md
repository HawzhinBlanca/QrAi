# Node backend port — Tasks

Scope approved 2026-07-31: **option A, the walking skeleton** — strangler shell + the four security
primitives + two routes. See [`plan.md`](plan.md) §4 and [`research.md`](research.md).

**Task-ID prefix `N` is deliberate.** `scripts/update-ledger.sh` matches `- \[ \] <task> ` across
**every** `specs/*/tasks.md`. Checked: existing ids are `F1…F5`, `MIG1…MIG5`, `P0.1…P7.6`,
`PAR1…PAR6`, `T0.1…T8`. `N1…N6` collides with nothing.

---

## N1 — Cross-language ticket vectors, before any Node code mints one

`specs/node-backend-port/fixtures/ticket-vectors.json` — 6 vectors asserted by **both** a Rust module
in `shared-ticket` and `tests/node-api/ticket-vectors.test.mjs`.

Generated **from Rust**, never from the port: vectors derived from a port pin the port's behaviour,
bugs included, and both suites agree while both are wrong.

**Acceptance:** both suites green; flipping one byte of `expectedTicket` fails **both**. Executed —
Rust reported `vector 'ascii-basic' drifted`, Node reported `not ok 1`.

- [x] N1 — Ticket vectors — Cross-language golden vectors, asserted in Rust and Node.

---

## N2 — The strangler shell

`services/node-api/server.mjs`. Fastify 5; anything not explicitly ported is proxied verbatim.

**Acceptance:** with **zero** routes ported, the whole Phase 6 parity suite passes against the shell
— **29/29**, including the pilot-cookie, CORS and metrics groups. The Phase 5 differ produces
**byte-identical output through the shell and direct to Rust**.

- [x] N2 — Strangler shell — Fastify proxy that the existing oracles cannot distinguish from Rust.

---

## N3 — The four security primitives, each with a test that fails on the naive port

| § | file | tests |
|---|---|---|
| 2.2 tenant transactions | `lib/db.mjs` | `tests/node-api/db-tenant.test.mjs` (8) |
| 2.3 ownership gate | `lib/authz.mjs` | `tests/node-api/authz.test.mjs` (17) |
| 2.4 CORS / 2.5 ordering | `server.mjs` | `tests/node-api/shell.test.mjs` (14) |

**§2.2 is the one that mattered.** Phase 6 proved RLS fails **closed** on a *missing* tenant context
and nothing about a *wrong* one. `db-tenant.test.mjs` demonstrates that a stale-but-valid context
fails **OPEN** — the database serves that tenant's rows — and then proves `withTenant` never leaves
one behind, including after a JS throw and after a server-side error.

**Acceptance:** 39 primitive tests green.

- [x] N3 — Security primitives — §2.2/§2.3/§2.4/§2.6 with must-fail tests for each.

---

## N4 — Port `GET /v1/learner/progress`

**Acceptance:** an A/B against Rust — same request to both, bodies compared — is identical on all 7
cases, including the 403/401 paths. Evidence: `evidence/n4-n5-ab-vs-rust.txt`.

- [x] N4 — Port progress — GET /v1/learner/progress, byte-identical to Rust.

---

## N5 — Port `POST /v1/realtime-session-tickets`, validated by the UNCHANGED Rust gateway

**Acceptance:** `tests/api-parity/realtime-ticket.test.mjs` (9 tests, new coverage) passes against
both implementations, **and** the unmodified Rust gateway accepts a Node-minted ticket over a live
WebSocket while rejecting tampered ones. Evidence:
`evidence/n5-gateway-accepts-node-ticket.txt`.

- [x] N5 — Port ticket mint — Node mints; the unchanged Rust gateway accepts.

---

## N6 — The honest report

- [x] N6 — Report — Measured findings, divergences, and what the oracles did and did not catch.

---

# N6 — Report

## The finding that justifies the whole phase

**I ported the ticket route before writing its coverage, and got it wrong in four ways while every
existing test stayed green.** Then I wrote the oracle, and **7 of its 9 checks failed**.

The four defects, all of which would have shipped:

| defect | consequence |
|---|---|
| allowed `teacher` and `scholar` to mint | a teacher gets a **live audio credential** for any learner |
| consent read from `consent_snapshot` JSON instead of the `external_processing_allowed` column | the ticket could tell the gateway external ASR was permitted when the server had resolved otherwise |
| no `audit_events` row | minting a realtime credential leaves **no audit trail** |
| no `realtime_session_tickets` row | no replay defence, no revocation surface, no record |

Plus no sample-rate negotiation, and a response missing 4 of its 8 fields.

Phase 7's plan §2 adopted the rule *"a route gets coverage before it gets ported"* from a measurement.
This is that rule demonstrated on the exact route the measurement flagged as the worst candidate —
the only credential that crosses a service boundary.

## Divergences the A/B caught, all now fixed except one recorded

| divergence | resolution |
|---|---|
| error strings — mine read better and were wrong (`"no usable credentials"` vs `"missing or invalid authorization"`) | matched verbatim; Phase 5's differ treats them as wire contract |
| JSON key order — `serde_json` without `preserve_order` emits keys **alphabetically** | matched |
| `nextReviewAt` format — chrono's `to_rfc3339()` emits `+00:00` with 0/3/6 fractional digits; `Date#toISOString` always emits `Z` with 3 | formatted in Postgres and trimmed to match |
| `expiresAt` is a **decimal string of unix seconds**, not RFC3339 | matched |
| missing `sessionId` → Rust **422** with serde's own text | **status matched; message RECORDED, not reproduced** — see below |
| a `u64` expiry does not survive `JSON.parse` (18446744073709551615 → ...552000) | vectors store it as a string; the `max-u64-expiry` vector caught it |

**The one open divergence:** Rust answers a malformed body with serde's message,
`"Failed to deserialize the JSON body into the target type: missing field \`sessionId\` at line 1
column 2"`. Reproducing that byte-for-byte means reimplementing serde's error formatting including
line/column offsets, and it leaks deserializer internals. The **status** (422) is matched because
that is what clients branch on. Changing either side is a separate, visible decision.

## What the shell got wrong, and what caught it

- **`app.all("/*")` + the auto-added HEAD route** → `FST_ERR_DUPLICATED_ROUTE` **at boot**. This is
  the duplicate-route detection `migration/plan.md §2.1` chose Fastify for, catching a real bug on
  its first run instead of silently serving one handler.
- **The proxy invented a `content-type`** on responses that had none (the `/metrics` 404). Caught by
  the Phase 5 differ as `keys differ … got [.., content-type]`.
- **Fastify's default JSON parser rejects an empty body** when `content-type: application/json` is
  set — which every Phase 6 request does, including GETs. That would have failed 29 tests at once
  with a 400 the Rust service never returns.

## Velocity — the number this phase exists to produce

| | |
|---|---|
| elapsed | one working session |
| Node written | ~700 lines across 4 files |
| tests written | **48** Node + **9** new parity + 3 Rust |
| routes ported | **2 of 34** |
| routes whose port was wrong until an oracle existed | **1 of 2** |

**Do not extrapolate to 32 remaining routes by multiplication.** The two chosen were deliberately
the cheapest: one had two oracles already, and the other is a leaf with no cascade. The routes left
include `privacy delete` (18 SQL sites, a cascade Phase 6 pins), `recitation` (21 sites, 757 lines)
and the 306-line pilot cookie path this skeleton **delegates rather than ports**.

The honest re-estimate is **not** "15 weeks confirmed". It is: the security primitives are solvable
and now exist, the strangler works and is reversible, and **the binding constraint is oracle
coverage, not Node code**. 8 of the 9 uncovered pairs still have none, and this phase demonstrated
what porting one of those looks like.

## What is still true and unsolved

- **8 uncovered pairs remain**, including `POST /v1/teacher-reviews`.
- **The pilot cookie path is not ported.** A cookie-bearing request is delegated to Rust — fail-safe
  and deliberate, but it means the ported routes are only really ported for header and Bearer auth.
- **`ALLOW_INSECURE_DEFAULTS` is not split** (§2.6). The shell reads the same single variable;
  splitting it is an operator-visible deployment change and belongs with a decision, not a skeleton.
- **Nothing is cut over.** The Rust service still serves all 34 routes in every real configuration;
  the shell is opt-in via `NODE_API_PORTED`, which defaults to empty.
- **A pre-existing fixture impurity, found here:** the Phase 5 privacy-export step expects a
  `pilot_invitation` record, but the 26-step scenario contains no successful invitation mint (step 23
  is the export; step 25 is a *rejected* mint). That expectation came from state that pre-existed in
  the capture database, so the differ is **25/26 on a freshly built database — for the Rust service
  too**. My own earlier work; recorded for a Phase 5 follow-up, not fixed here.

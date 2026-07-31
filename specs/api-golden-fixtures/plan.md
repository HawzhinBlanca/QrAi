# Plan — golden API fixtures from the Rust service

**Status: APPROVED 2026-07-30** by the repo owner in session (AGENTS.md step 2 gate satisfied).
**Research:** `research.md`. **Measured at** main `964ffef`.
**Phase 5 of** `specs/flutter-node-migration/plan.md` — the first phase that is migration work
rather than preparation.

**Approved-by:** repo owner (HawzhinBlanca), 2026-07-30, in session — scope F1-F5 as written below.

---

## 1. What "absolute number 1" means for this specific artifact

Not "more fixtures". For a behavioural baseline, best-in-class means four properties, and each one
is a thing that goes wrong in practice:

1. **Deterministic** — a re-run against the *same* service produces identical output. Research §2
   shows this is the hard part: 9 volatile field families make a naive capture fail on its second
   run, against the very service that produced it.
2. **Adversarially complete** — error paths, auth failures, and refusals, not just 200s. A baseline
   of happy paths lets a port get every failure mode wrong while passing.
3. **Byte-exact where it is contractual** — key casing, error message strings, status codes. The
   `/v1/auth/token` snake_case body (research §3.1) is the case that a "helpful" normalizer erases.
4. **Executable as a differ** — the artifact's job is to fail loudly against a non-conforming
   implementation. A fixture set nobody can run against a candidate is documentation, not a baseline.

A fixture set that is merely large fails all four.

## 2. Approach

**Record a scripted scenario against the live Rust service, normalize volatile values to typed
placeholders, and commit the result as canonical JSON with a digest.**

Rejected alternatives:

- **Capture by proxy/tcpdump** — records TLS/transport noise and couples fixtures to a client's
  exact header order. Fragile and unreadable in review.
- **Generate from OpenAPI** — there is no OpenAPI document (Phase 5's sibling finding), and a
  generated spec would describe what someone *believes* the API does. The whole point is to record
  what it *actually* does.
- **Reuse the 79 integration tests as the baseline** — they assert behaviour in Rust, which is what
  the port replaces. They cannot be run against a Node implementation.

**Reuse `scripts/smoke-api.mjs`'s request construction** rather than writing a second definition of
how to call this API (research §4).

---

## 3. Tasks

### F1 — The normalizer, first and independently tested

Before any capture: a pure function that walks a JSON body and replaces volatile values with typed
placeholders, asserting shape as it goes.

- `<UUID>` — must match a UUID pattern to be replaced; a non-UUID `id` is a **finding**, not noise.
- `<ISO8601>`, `<JWT>` (three base64url segments), `<CSRF>`, `<TRACE_ID>`.
- **Key casing is never normalized.** Explicit non-goal, called out in the code, because that is
  what protects `/v1/auth/token`'s snake_case body.
- Field-path aware: `learnerId` in a request body the test *sent* is a known value and must stay
  literal; only server-generated values are placeholdered.

**Tests (`t-f1-normalize`)**: a UUID is replaced; a non-UUID `id` raises rather than silently
passing; two captures of the same response with different UUIDs normalize identical; a snake_case
key survives untouched; a JWT is replaced but a random string in a `token` field raises.

*Why first: if the normalizer is wrong, every fixture it produces is wrong, and the error is
invisible — the fixtures will simply agree with each other.*

### F2 — The capture harness

`scripts/capture-api-fixtures.mjs`. Drives a scripted scenario against a running platform-api,
records `{request, response}` per step, normalizes via F1, writes canonical JSON.

- **Requires an explicit target URL, no default** — same rule as `restore-db.sh` (P4-T1). Capturing
  against a real environment by accident would write live data into a git-committed fixture.
- Records status, **response headers that matter** (`content-type`, CORS, `set-cookie` shape), and
  body.
- Ordered scenario, because state is coupled (research §6): register → login → create session →
  persist alignments → request review → privacy export → pilot mint/bootstrap/logout.

**Tests (`t-f2-capture`)**: running the harness twice against the same service produces
**byte-identical** output. That single assertion is the one that proves determinism, and it is the
test most likely to fail first.

### F3 — Coverage: the failure cases, deliberately

Not an afterthought. The scenario must include, at minimum:

| Case | Why |
|---|---|
| 401 with dev headers while `ALLOW_HEADER_AUTH` is **off** | A shipped security control (P1.5) |
| 403 cross-tenant read | Tenant isolation is the system's core promise |
| 404 on a missing record | Distinguishes "absent" from "forbidden" |
| 400 with each `ApiError` message string | The strings are contract (research §3.2) |
| `/metrics` **404** (not 401) with a wrong token | Deliberate design; trivially "fixed" by a port |
| Oversized body rejection | The 2 MB / 16 MB split (research §7.4) |
| Pilot cookie mutation without Origin / with bad CSRF | Browser-only controls a port will not have |

**Acceptance:** every `ApiError` variant in `types.rs:334` appears at least once in the fixture set.
Mechanically checkable, and the honest way to define "complete" here.

### F4 — The differ

`scripts/diff-api-fixtures.mjs` — replays the fixture set against **any** base URL and reports
per-step differences: status, headers, normalized body, key casing.

This is what makes the artifact useful in Phase 7 instead of a folder nobody opens. Exit non-zero on
any difference.

**Tests (`t-f4-differ`)**: the differ reports PASS against the service that produced the fixtures,
and **FAILS** when given a deliberately altered fixture (one changed status, one changed error
string, one camelCased snake_case key). Without that second half, a differ that always passes would
look identical to a correct one.

### F5 — Gate it, DB-gated

Wire into `scripts/verify.sh` alongside the existing DB-gated block: when a live Postgres and API
are reachable, run F4 against the Rust service. An accidental API change then fails the gate the day
it happens, not during the port.

**Skipped when no DB is present, exactly like the integration tests — and skipped loudly, never
faked.**

---

## 4. Non-goals

- **Not** an OpenAPI document. That is Phase 7's `utoipa` question (ADR needed); this records
  reality, it does not specify intent.
- **Not** a replacement for the 79 integration tests. Those test the Rust implementation; these
  describe the contract the *next* implementation must satisfy.
- **Not** performance capture. Timings belong to P5.4.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Non-determinism makes fixtures flaky, and they get deleted for being annoying | F1 first, tested independently; F2's byte-identical-twice test |
| Over-normalization hides a real regression | Normalizer asserts shape and **raises** on unexpected values; key casing never normalized |
| Real learner data committed to git | Seeded synthetic learners only; a fixture-content check for known synthetic ids (research §7.3) |
| Fixtures rot as the API changes | F5 gates them; drift fails the gate the day it appears |
| The differ always passes and nobody notices | F4's test asserts it FAILS on deliberately altered fixtures |
| Colon-in-path routes corrupted by tooling | Noted in research §1; fixture keys are the literal path, never a filename-derived form |

---

## 6. What this phase does NOT establish

- That the Node port is correct — only that a conforming implementation is **checkable**. Phase 7
  does the porting.
- That the API design is good. This records what exists, faithfully, including anything odd. The
  snake_case `/v1/auth/token` body is preserved, not silently repaired: **fixing it is a separate,
  visible decision**, and burying it in a migration is how contracts break for callers.
- Anything about the realtime WebSocket path — different protocol, and the gateway is captured
  separately or not at all in this phase.

---

## 7. Open questions

1. **Location:** `specs/api-golden-fixtures/fixtures/` or `packages/api-fixtures/` so a future Node
   implementation can consume them as a dependency? (MIG3 set a `packages/` precedent.)
2. **Does F5 run in CI?** CI has a live Postgres, so it could — but the API must also be running,
   which CI does not currently do. Adding that is a real CI change.
3. **Gateway coverage:** in scope for a later phase, or now? Its ticket is an HMAC wire contract
   shared with platform-api, so the two are coupled at cutover.

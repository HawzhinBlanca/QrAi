# Where the two Node backends disagree

Measured 2026-08-12 against `main` (`services/node-api`) and PR #388 (`server/`, head `5be8a41`).

ADR-0060 makes `server/` the backend and freezes `services/node-api`. Its first named risk is that
the shared controls now exist **twice, independently**: main's are proven by parity tests written
against `services/node-api`, and `server/`'s are separate code those tests have never run against.

This is the list of what actually differs. It exists because "both trees have rate limiting" is the
kind of sentence that ends an investigation, and the interesting part is always one level down.

## Why this is a document and not a guard

A guard would have to run both implementations and compare them. `server/` is not on `main`, and it
cannot be booted here: it needs `@fastify/websocket` and `@aws-sdk/client-s3`, neither of which is
installed, and adding a runtime dependency needs an ADR (AGENTS.md).

So this is a **static** comparison — read from both sources, no execution. It is evidence for the
merge, not a substitute for step 3 of ADR-0060's sequence: point
`tests/api-parity/lib/harness.mjs:451` at `server/src/main.mjs` and run the real suite. Everything
below should be re-checked there, and anything this missed will surface there.

---

## 1. The rate limiter evicts 10× sooner, and no test would notice

| | `services/node-api/lib/rate-limit.mjs` | `server/src/lib/admission.mjs` |
|---|---|---|
| burst / capacity | `BURST = 200` | `capacity = 200` |
| refill | `REPLENISH_MS = 50` | `refillIntervalMs = 50` |
| **key bound** | **`MAX_KEYS = 100_000`** | **`maxKeys = 10_000`** |
| idle eviction | none | `idleTtlMs = 10 * 60 * 1000` |

The two numbers a parity test checks — burst and refill — **match**, and both mirror the Rust
governor. The eviction bound does not, and it is the one no test exercises: the parity suite compares
behaviour against Rust at a handful of client keys, far below either ceiling.

Why it matters rather than being a tuning detail: evicting a bucket **resets that client's
rate-limit state**. A tighter bound is reached sooner under key rotation, so the limiter is
correspondingly easier to walk past by cycling source addresses. 10 000 keys is not a large number
for a tenant behind a mobile carrier NAT range.

The draft's `idleTtlMs` is a real improvement main lacks — it reclaims idle buckets on time rather
than only under pressure. The right end state is probably the draft's TTL **with** main's ceiling.

**Neither number is obviously correct.** This needs a decision, not a merge.

## 2. The superuser guard is stricter on the draft — and it collides with a test merged today

| refuses to boot when the DB role has | main | draft |
|---|---|---|
| `SUPERUSER` | yes | yes |
| `BYPASSRLS` | yes | yes |
| `CREATEDB` | no | **yes** |
| `CREATEROLE` | no | **yes** |
| `REPLICATION` | no | **yes** |
| gated by an escape hatch | `ALLOW_SUPERUSER_DB_ROLE` | `enforceRestrictedDbRole` |
| on a failed `pg_roles` query | returns a diagnosable problem string | throws at `onReady` |

Both fail closed; the draft is simply stricter, which is defensible — `CREATEROLE` is a privilege
escalation path and `REPLICATION` can read the WAL.

The concrete collision: the development role used by the harness has `rolcreatedb = t`, and
`tests/observability/postgres-outage.test.mjs` (merged today) **requires** `CREATEDB` — it creates a
throwaway database and drops it to simulate an outage. Under the draft's rule that role is refused
unless `enforceRestrictedDbRole` is off, so adopting it changes what CI and local setup must provide.

Not a defect in either. It is a setup requirement that will look like a mysterious boot failure if
nobody writes it down first.

## 3. The route allowlist changed shape, and the cutover gate must move with it

| | main | draft |
|---|---|---|
| declaration | `export const PORTABLE = ["GET /health", …]` | `export const ROUTES = [{ key, method, path, handler, ownerGate? }, …]` |
| keys | 37 | 44 |
| read by the cutover gate via | a **regex over source text** | a real `import` of `ROUTES` |

ADR-0034 chose the string list *deliberately*: a computed value like `ROUTES.map(r => r.key)` makes
the regex miss, and `checkTrafficShare` then reports zero portable routes **while still exiting 0** —
a gate that fails silently open.

The draft does not reintroduce that hazard; it removes it properly. `ROUTES` is a hand-written
44-entry literal (not derived from the handler set, which was ADR-0034's other objection), and
`scripts/cutover-readiness.mjs` on the draft **imports** it rather than regexing. Importing the real
value is strictly better than pattern-matching its source.

But the two halves must move together, and the failure mode is worth stating **precisely** rather
than dramatically — I overstated it on the first pass and checked.

Run main's `checkTrafficShare` against `server/src/app.mjs` and it does **not** fail silently open:

- the regex finds nothing → `count = 0`
- `NODE_API_PORTED ?? ""` is absent → `defaultsEmpty = false` → `served = null`
- `null === totalPairs` is false → the check reports **UNMET**

So it fails *closed*. What it emits, though, is the fallback detail: *"default routing is not the
empty set — read `services/node-api/server.mjs` before trusting this"* — naming a file that the
migration deletes, about a backend whose default genuinely is the empty set. A correct verdict for
the wrong reason, pointing at nothing.

That is a smaller problem than a silent-open gate, and still a real one: the first person to hit it
will go looking for a file that is gone. **Migrate `scripts/cutover-readiness.mjs` in the same
change as `server/`, not after it.**

## 4. The proxy path forwards a client-supplied `x-forwarded-for` — the #409 defect, narrowed

This is the one I got wrong first. An earlier draft of this file listed `x-forwarded-for` under
"what matched exactly", on the strength of a file-count grep. Reading the code says otherwise.

**Main** (`services/node-api/lib/proxy.mjs:57`) overwrites the header from the real socket before
forwarding:

```js
if (clientAddress) {
  headers["x-forwarded-for"] = clientAddress;
  headers["x-real-ip"] = clientAddress;
}
```

That line is #409. Its comment records the measurement: *"a request carrying
`x-forwarded-for: 1.2.3.4` reached the upstream with `x-forwarded-for: 1.2.3.4`, and the shell added
nothing of its own."*

**The draft** (`server/src/lib/proxy.mjs:34-37`) copies every non-hop-by-hop header **verbatim** and
sets neither. So in compatibility mode, a client-controlled `x-forwarded-for` reaches Rust
platform-api, whose governor keys its limiter on exactly that header.

### Why this is narrower than #409 was, and still worth fixing

The draft's **own** limiter is correct — better than main's, in fact:

```js
const decision = rateLimiter.consume(req.ip);   // app.mjs:219
```

`req.ip` is Fastify's `trustProxy`-aware resolution, configured from `TRUSTED_PROXY_HOPS`, and the
code says so: *"Admission never trusts caller-supplied role/tenant data and uses only Fastify's
peer/trusted-hop IP resolution."* At the time of #409 main's shell had no limiter at all, so the
spoofable header was the only thing standing between a client and the upstream. Here a correct
limiter sits in front of the leaky one, which makes this defence-in-depth rather than an open door.

**Except when the front limiter is off.** `rateLimitEnabled` is a flag, and the parity harness sets
`DISABLE_RATE_LIMIT=1` in `BASE_ENV`. That is the configuration the entire A/B suite runs under — so
the spoofable header reaches Rust in precisely the mode where nothing is in front of it, and no
existing test can see it. This repo already has a name for that shape: *a control disabled in the
harness cannot be found missing by that harness.*

The fix is one block, ported from main's `proxy.mjs`, and it should land on `server/` **before** the
harness is pointed at it — otherwise step 3 of ADR-0060 proves parity on a path that has silently
lost a control.

## What matched exactly

Worth stating, because a comparison that reports only differences is not trustworthy:

- **Upstream timeout default** — 60 s in both (`DEFAULT_UPSTREAM_TIMEOUT_SECS` / `timeoutMs = 60_000`).
- **Maintenance exemption set** — `/health`, `/ready`, `/metrics`, identical in both, and identical
  to the Rust original that `maintenance-parity.test.mjs` compares against.
- **Trace propagation** — present in both; the draft carries it through more call sites.
- **Route lineage** — every one of main's 14 route modules exists on the draft under the same name.

## What this comparison could not reach

- **Behaviour.** Everything above is read, not run. Two implementations can agree line for line and
  still differ under concurrency, and the draft's limiter uses `performance.now()` where main's uses
  `Date.now()` — a monotonic-vs-wall-clock difference that only shows up under a clock step.
- **The realtime boundary and `inference/`.** Main has no counterpart, so there is nothing to diff.
  Those are new surface, and they need their own evidence rather than a comparison.
- **`services/ml-inference` equivalence.** That `server/inference/` and `server/storage/` faithfully
  replace it is the second risk in ADR-0060 and is not addressed here at all.

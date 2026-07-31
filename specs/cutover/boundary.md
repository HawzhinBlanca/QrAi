# The new trust boundary — review package for P1.7

**Purpose:** give a security reviewer what they need to challenge and then sign or refuse `P1.7`
("challenges the deployed candidate identity boundary and signs the result").

**This document is not an assurance.** Every claim below names a committed test or evidence file, and
`tests/contract/boundary-references.test.mjs` asserts each of those paths exists — so this cannot rot
into citing things that were deleted. A review package whose claims cannot be checked is worse than
none, because it reads as assurance.

**Nothing described here is deployed.** `services/node-api/server.mjs` serves **0 of 38** routes in
any default configuration. Run `node scripts/cutover-readiness.mjs` for the current state.

---

## 1. What is actually new

A second process — `services/node-api` — that would sit **in front of** the Rust `platform-api`.

```
client ──► node-api (Fastify) ──┬── a ported route  ──► Postgres
                                └── everything else ──► platform-api (unchanged)
```

| addition | consequence for the boundary |
|---|---|
| a second process terminating client requests | one more place auth can be decided, and one more place it can be decided *wrongly* |
| a proxy hop for every unported route | headers, cookies and bodies are copied by our code rather than passed by a kernel |
| a second Postgres client (`postgres`, porsager) | a second implementation of the tenant-isolation discipline (§3.1) |
| 6 new runtime dependencies | fastify, @fastify/cors, postgres, zod, jose, ws — all inside `pnpm audit` |
| `tests/node-api/*` + `services/node-api/*` | new code paths, none of them yet load-bearing |

`services/platform-api` and `services/realtime-gateway` are **unchanged**. No production Rust was
edited in Phases 7–9.

## 2. What it deliberately does NOT do

**The pilot cookie path is delegated, not ported.** Any request carrying `__Host-qrai-pilot` is
proxied to Rust untouched — `services/node-api/lib/authz.mjs`.

That is 306 lines of session lookup, idle-roll, CSRF digest and Origin allowlisting
(`services/platform-api/src/handlers/pilot.rs`) that the Node service does not reimplement.
Half-porting it is the regression this whole migration was structured to avoid, so it fails **safe**:
the request goes to the implementation Phase 6 already proved.

- Proven by: `tests/node-api/authz.test.mjs` — *"a pilot cookie DELEGATES rather than being
  half-authenticated here"*.

## 3. The four security-critical primitives, and the evidence for each

### 3.1 Tenant isolation across a connection pool

Rust binds every statement in a tenant transaction to one connection by RAII. A JavaScript port that
released a client while still inside a transaction would return it to the pool **with
`app.tenant_id` still set** — and a stale-but-valid tenant fails **OPEN**, because
`tenant_id = app.current_tenant_id()` is simply true for the wrong tenant's rows.

Phase 6 proved RLS fails **closed** on a *missing* context. It proved nothing about a *wrong* one.

- Implementation: `services/node-api/lib/db.mjs` — `sql.begin()` binds the connection structurally;
  the caller never holds a handle to leak.
- Proven by: `tests/node-api/db-tenant.test.mjs` — including a test that **demonstrates the
  fail-open** directly, and three that prove nothing leaks after a JS throw, after a server-side
  error, or under interleaved transactions.

### 3.2 The ownership gate

`undefined === undefined` is `true`. This is the only ownership check on 8 endpoints.

- Implementation: `services/node-api/lib/authz.mjs` — refuses degenerate input **before** comparing.
- Proven by: `tests/node-api/authz.test.mjs` — 17 tests, most asserting refusal, including
  `undefined`, `null`, empty and whitespace-only pairs, a missing owner column, a malformed
  allowlist, a token missing a claim, and an `alg: none` token.

### 3.3 CORS

tower-http emits the literal `*`, which browsers refuse to combine with credentials — that refusal is
what stops a cross-origin page sending the pilot cookie today. `@fastify/cors`'s `origin: true`
**reflects** the request Origin, which *is* valid with credentials.

- Implementation: `services/node-api/server.mjs` — literal `"*"`, never `true`; `credentials: true`
  refused at **boot**.
- Proven by: `tests/node-api/shell.test.mjs` — asserts `access-control-allow-credentials` is absent
  from **every** response, and that configuring it throws.

### 3.4 `ALLOW_INSECURE_DEFAULTS` — split, and one earlier claim here was wrong

**Two corrections to what this section said before** (`specs/insecure-defaults-split/research.md`):

1. 🔴 **It claimed "the Node shell reads the same single variable." It does not.**
   `services/node-api/` contains no insecure-defaults read of any kind — `server.mjs` reads
   `PLATFORM_API_UPSTREAM`, `NODE_API_BIND`, `NODE_API_PORTED`, `DATABASE_URL`, `JWT_SECRET`,
   `ALLOW_HEADER_AUTH`, `CORS_ALLOWED_ORIGINS` and `REALTIME_GATEWAY_TICKET_SECRET`. A review package
   that overstates a blast radius trains its reader to discount it, so this is corrected rather than
   quietly dropped.
2. **`migration/plan.md §2.6` undercounted at five controls.** There are **six**: it missed chaos
   fault injection (`services/realtime-gateway/src/lib.rs`), whose own comment promises a production gateway
   "cannot be told to sabotage itself" — a promise that rested entirely on this variable.

**Now split** (`ADR-0024`) into `ALLOW_INSECURE_SECRETS`, `ALLOW_SUPERUSER_DB_ROLE`,
`METRICS_DEV_OPEN`, `GATEWAY_ALLOW_MISSING_ORIGIN`, `ALLOW_CHAOS_INJECTION`.
`ALLOW_INSECURE_DEFAULTS` survives as a working alias with a boot warning and a refusal to start
when combined with a per-control variable.

- Proven by: `services/realtime-gateway/src/insecure.rs` and
  `services/platform-api/src/insecure.rs` (resolver + 18 unit tests),
  `tests/security/legacy-insecure-flag.test.mjs` (no production artifact ships a relaxation on).
- **The security-relevant part:** `GATEWAY_ALLOW_MISSING_ORIGIN` relaxes only the missing-`Origin`
  branch — a request carrying a disallowed `Origin` is **still 403**. Asserted in
  `missing_origin_knob_does_not_disable_the_allowlist`.
- The `"1"`/`"true"` asymmetry is **deliberately preserved inside the deprecated alias**, so
  `tests/api-parity/metrics.test.mjs` — which depends on it — passes unchanged.
- **Still for the reviewer**, and narrower than before: the alias is not *removed*, and the
  "never set in production" assertion `§2.6` asked for **is not implemented**. No service knows what
  environment it is in. The repo gate catches a bad committed default and **cannot** catch an
  operator exporting the variable by hand.

### 3.5 🔴 The gateway never received `CORS_ALLOWED_ORIGINS` in compose — found while doing 3.4

`docker-compose.yml` set `CORS_ALLOWED_ORIGINS` on **platform-api only**. The gateway reads the same
variable for its CSWSH allowlist and, when it is unset in strict mode, **returns 403 to every
WebSocket upgrade** — including from an allowed browser origin.

So a production compose deploy (`ALLOW_INSECURE_DEFAULTS=0`, which is the committed default) had
**realtime audio entirely broken**, and the failure mode is a security control rejecting legitimate
traffic rather than admitting illegitimate traffic. Fixed in the same change; there is no deployment,
so nothing was live.

**A reviewer should note what this implies:** the gateway's strict-mode path had never been exercised
against the committed compose configuration.

## 4. The cross-service credential

`POST /v1/realtime-session-tickets` mints the HMAC the `realtime-gateway` trusts. Node can mint one
the **unchanged** Rust gateway accepts.

- Proven by: `specs/node-backend-port/evidence/n5-gateway-accepts-node-ticket.txt` — a live WebSocket
  handshake, plus rejection of a tampered signature and a swapped tenant.
- Pinned by: `specs/node-backend-port/fixtures/ticket-vectors.json`, asserted in **both** languages.

**A reviewer should note how this was found.** The first Node implementation of this route was
written before its coverage existed and was wrong four ways — it let **teacher and scholar mint a
live audio credential**, read consent from the wrong source, and wrote neither the audit row nor the
ticket row. Every pre-existing test stayed green. The oracle written afterwards failed 7 of 9.

- Recorded in: `specs/node-backend-port/tasks.md` (N6).
- The coverage that now exists: `tests/api-parity/realtime-ticket.test.mjs`.

## 5. What is NOT covered — stated as gaps, not omitted

- **8 of 38 method+path pairs have no fixture and no parity test.** Counted by
  `scripts/cutover-readiness.mjs`, which names the number every run.
- **15 of 38 contracted operations are `x-unvalidated`** — permissive response schemas, because no
  committed evidence of their shape exists. Marked so the gap is countable;
  `tests/contract/coverage.test.mjs` pins the count so it can only shrink deliberately.
- **No rollback artifact.** ADR-0022 is **Proposed**. Rollback today is a rebuild.
- **P5.5 / P5.6 open** — kill switch, rollback and DR drill not proven.
- **No load, soak or chaos testing** of the two-process topology.
- **Zero users and login disabled**, so there is no production behaviour to observe.

## 6. What a reviewer is actually being asked to sign

Not "is the Node service secure" — it serves no traffic.

The honest question is narrower: **if these two processes were deployed with `NODE_API_PORTED`
non-empty, would the identity boundary be at least as strong as it is today?** §3 is the evidence
for; §5 is the evidence against; §3.4 is unresolved.

**A refusal is a legitimate outcome and should not be read as a failure of this document.**

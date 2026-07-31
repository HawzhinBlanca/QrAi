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

### 3.4 🔴 `ALLOW_INSECURE_DEFAULTS` — NOT split, and this is a live finding

`migration/plan.md §2.6` requires splitting one variable that disables five independent controls.
**That was not done.** The Node shell reads the same single variable.

Worse, Phase 6 measured that it already means two different things: `metrics_dev_open` checks
`== "1"` (`lib.rs:86`) while main.rs's boot checks accept `"1" OR "true"`. So
`ALLOW_INSECURE_DEFAULTS=true` skips the production secret and superuser-role checks while leaving
`/metrics` closed.

- Recorded in: `specs/api-parity-suite/tasks.md` (Findings §2) and `tests/api-parity/metrics.test.mjs`,
  which **depends** on the asymmetry and goes red if someone "fixes" it.
- **Open for the reviewer.** A reviewer should treat this as unresolved, not as documented-therefore-fine.

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

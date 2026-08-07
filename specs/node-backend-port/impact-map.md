# Impact map — Phase 7: the Node backend (option A, walking skeleton)

Under option **B** the file list is the same shape; only the number of ported routes grows, and
`services/platform-api` eventually loses callers. Option **C** is N1 alone plus coverage work.

---

## 1. New — no existing callers, nothing can break

| path | what | task |
|---|---|---|
| `services/node-api/` | the Fastify strangler shell | N2 |
| `services/node-api/lib/db.mjs` | `sql.begin`-scoped tenant transactions (§2.2) | N3 |
| `server/src/lib/authz.mjs` | `requireSelfOrAny`, fail-closed on degenerate input (§2.3) | N3 |
| `server/src/lib/ticket.mjs` | HMAC minting; the only Node code that may produce `rt_v1.…` | N5 |
| `specs/node-backend-port/fixtures/ticket-vectors.json` | cross-language golden vectors | N1 |
| `specs/node-backend-port/evidence/` | N5's live-gateway run, N6's report | N5, N6 |

`services/node-api` is a **new service directory**, not a pnpm workspace member — same choice as
`services/ml-inference` and `services/agents`, whose `node:test` files run by explicit path from
`verify.sh:121`. Adding it to `pnpm-workspace.yaml` would pull it into `test: ts`, `typecheck`, and
`build`, none of which fit a plain-`.mjs` service.

## 2. Modified — every one has real callers

### `services/shared-ticket/src/lib.rs` (N1, **test module only**)

**Callers: both Rust services.** `platform-api` mints, `realtime-gateway` validates. The change is a
`#[cfg(test)]` assertion against the committed vectors — **no production code path changes**.

The vectors must be generated **from Rust and asserted in Node**, never the reverse. Vectors derived
from the port would pin the port's behaviour, bugs included, and both suites would agree while both
were wrong. Same failure mode as a normalizer whose every output agrees with every other (Phase 5).

### `scripts/verify.sh` (N2, N3)

**Callers: everything** — CI, both `.claude/settings.json` hooks, `AGENTS.md:24`, `README.md:70`.

Two additions:
- `test: node-api` on the hermetic explicit-path line (`:121`) for the primitives' unit tests.
- The DB-gated block gains a **second** parity run against the composite (shell + Rust), so both the
  Rust-alone and shell configurations are gated. Doubling that block's runtime is the cost.

Protected by the CODYSTEM PreToolUse guard; needs the `.codystem-allow-self-edit` sentinel, as PAR5
did. Audited and visible, not routed around.

### `scripts/verify-parity-teeth.sh` (N3)

One mutation per security primitive. **The mutations must weaken the NODE path**, so they only bite
once a route is served by Node — before N4 they would be no-ops, and a no-op mutation is a failure by
this script's own rule. So the primitive mutations land **with** N4, not with N3.

### `.github/workflows/ci.yml` (N2, N5)

Starts a second process (the shell) and, for N5, the **realtime-gateway** — which CI does not run
today. That is new CI surface: a WebSocket handshake in CI is the most likely source of flake in this
plan.

### `docs/DECISIONS.md`

ADRs for: Fastify + `postgres` (porsager) over `pg` for the service (ADR-0023 chose `pg` for
**tests** and explicitly took no position on the service — §2.2 is why the service needs different
properties); the strangler topology; the `ALLOW_INSECURE_DEFAULTS` split (§2.6), which is an
**operator-visible breaking change** to deployment config.

### `package.json` / `pnpm-lock.yaml`

Fastify 5, `postgres`, zod 4, jose 6, `@node-rs/bcrypt`, ws 8 — **six new dependencies**, all
entering the `pnpm audit` supply-chain gate that went repo-wide red on GHSA-r28c-9q8g-f849 (MIG5).
`@node-rs/bcrypt` ships prebuilt napi binaries, so it is the one to watch on a CI arch change.

## 3. Read, not modified — the coupling that keeps the port honest

`specs/api-golden-fixtures/fixtures/platform-api.json` and `tests/api-parity/**` are the oracles.
They are **black-box by construction** (Phase 6), so they run against the shell with no change —
that was the point of building them that way.

**They must not be edited to accommodate the port.** If Node and Rust disagree, the finding is
recorded, exactly as Phase 5 recorded 200-not-201 and 403-not-401. An oracle edited to match the
thing it measures is no longer an oracle.

`tests/api-parity/coverage.json` gains no entries: it tracks the **Rust** suite, and this phase adds
no Rust tests beyond N1's vector module.

## 4. Not touched

- `services/platform-api/src/**` and `services/realtime-gateway/src/**` — no production Rust changes.
  N5's whole point is the **unchanged** gateway accepting a Node-minted ticket.
- `apps/web`, `apps/mobile` — no client change; the shell is transparent.
- `infra/migrations/**` — no schema change. A port that needed one would be redesigning, not porting.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **§2.2 stale tenant leaks across tenants** | **nobody — no existing test covers a *wrong* context, only a missing one** | N3's must-fail test, required **before** any tenant-scoped route ports |
| Proxy mangles cookies or headers | immediately — the full suite runs against a zero-route shell (N2) | N2's acceptance is exactly this |
| A ported route regresses | the fixture differ or parity suite, attributed to that route | one-line flip back to the proxy |
| Six new dependencies | `pnpm audit`, on some future advisory | pinning forward, as #261 did |
| CI flake from the WebSocket handshake | every PR, on unrelated changes | N5 is the only task needing it; if it flakes it moves out of the required gate and says so |

## 6. What has no mitigation, and should be named

If the answer at N6 is "continue", the remaining ~32 pairs include the **8 still-uncovered** ones.
Nothing in this phase closes those, and no amount of care substitutes for an executable check. That
work — closing the oracle gap — is a prerequisite for porting them, and it is not in this plan.

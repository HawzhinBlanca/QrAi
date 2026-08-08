# W3.3 plan — realtime admission and ticket parity

**Status:** PROPOSED — implementation is blocked on this exact child-plan approval<br>
**Approved-by:**<br>
**Criteria:** RTA-1…RTA-7; parent RT-1

## Decision

Add admission to the existing internal `node-realtime` Fastify process; do not create another
package, image, listener, ticket implementation, or traffic edge. Pin `@fastify/websocket` 11.3.0
as the one supported server adapter because it preserves Fastify routing, pre-upgrade hooks, peer-IP
resolution, and close lifecycle while using the established `ws@8` implementation. Record this new
runtime dependency in ADR-0052.

Create one small pure `server/src/realtime/admission.mjs` boundary that reuses
`validateRealtimeTicket` and `createTokenBucketLimiter`. It owns exact Origin/native decisions,
tenant and maximum-lifetime checks, generic rejection classes, trace extraction, fixed counters,
and the Fastify pre-validation hook. It never persists or returns the raw ticket. W3.4 will add a
replay authority after validation and before upgrade; W3.5 will replace the default unavailable
socket seam with bounded audio handling.

## Test-first implementation sequence

1. Add red `tests/realtime/ticket-boundary.test.mjs` cases for strict config, all six Rust-generated
   fixtures, signature/session/tenant/retention/expiry/lifetime refusals, the full Origin/native
   matrix, deterministic and real rate admission, exact-route 101, unavailable close, fixed metrics,
   and absence of credential/identity persistence. Add its exact-one canonical invocation guard.
2. Extract the existing named malformed-ticket builder into
   `tests/realtime/ticket-hostile-cases.mjs` and make both the unchanged Rust real-process sweep and
   the red Node suite consume it. Preserve all seven Rust hostile/frame/liveness tests and add no
   Node-derived protocol truth.
3. Add ADR-0052 and exact `@fastify/websocket` 11.3.0 to `server/package.json`; regenerate the frozen
   lockfile. Prove its MIT licence, clean audit, server lint/type/build, production-only deployment,
   and no optional native addon or second image/package.
4. Implement the pure admission module. Observe time once, verify HMAC before maximum-lifetime and
   tenant decisions, retain Rust's non-empty signed-retention semantics, parse canonical Origin
   configuration, separate native no-Origin, reuse the bounded token bucket, and return only frozen
   claims/trace or fixed 401/403/429 decisions. Do not add replay state, a database call, or raw-token
   logging/metrics.
5. Extend `parseRealtimeConfig` with required ticket/tenant and explicit Origin/native/rate/proxy
   configuration. Register the plugin before all routes, replace the W3.2 raw refusal listener with
   one exact WebSocket route and pre-upgrade admission, and add fixed outcome counters. The default
   admitted-socket seam must synchronously close 1013/unavailable and process no message; W3.2
   readiness, private metrics, failure isolation, and bounded shutdown remain green.
6. Wire the same security inputs into only the internal `node-realtime` Compose role and add that
   role to the existing opt-in native overlay. Keep no host port, Web dependency, Rust-gateway
   dependency, reverse-proxy target, release traffic role, or canary movement. Update production
   image/topology and legacy-insecure tests to pin those facts.
7. Update README plus architecture/testing/staging/monitoring living text with implemented admission
   and explicit replay/audio/traffic gaps. After each implementation task run the canonical gate;
   after the final task run it with live restricted Postgres, push, require exact-SHA remote checks,
   then and only then update the W3.3 ledger via `scripts/update-ledger.sh`.

## Exact implementation surface

- New runtime/test helper: `server/src/realtime/admission.mjs`,
  `tests/realtime/ticket-boundary.test.mjs`, and
  `tests/realtime/ticket-hostile-cases.mjs`.
- Runtime composition: `server/src/realtime/main.mjs`; reuse unchanged
  `server/src/lib/{ticket,admission}.mjs`.
- Dependency graph: `server/package.json`, `pnpm-lock.yaml`; no root/runtime package split.
- Oracle/gates: `tests/gateway/ws-hostile-input.test.mjs`,
  `tests/realtime/process-lifecycle.test.mjs`, `tests/node-api/production-image.test.mjs`,
  `tests/security/legacy-insecure-flag.test.mjs`,
  `tests/contract/verify-invocations.test.mjs`, and `scripts/verify.sh`.
- Deployment: `docker-compose.yml`, `docker-compose.native.yml`; release overlay, proxy target,
  monitoring scrape topology, image inventory, and client endpoints remain unchanged.
- Decisions/living docs: `docs/DECISIONS.md`, `docs/architecture/10-10-platform.md`,
  `docs/TESTING.md`, `docs/STAGING_RUNBOOK.md`, `README.md`, and `monitoring/README.md`.

## Risks and rollback

- A pre-upgrade ordering bug can authenticate after 101. The real raw-handshake tests require every
  Origin/rate/ticket refusal before upgrade, and plugin registration precedes every route.
- A permissive native switch can remove browser CSWSH protection. The decisive negative case is a
  disallowed supplied Origin while native no-Origin is enabled.
- `ws` defaults are not audio safety evidence. W3.3's default handler closes immediately and makes
  no RT-2 claim; W3.5 must add measured frame/payload/session ceilings before any traffic.
- Rollback removes the plugin route/dependency and restores the fixed 404 upgrade listener. Fixtures,
  Node HTTP, worker, Rust gateway, clients, stored data, and release traffic remain unchanged.

## Verification boundary

Focused tests and `git diff --check` are development feedback only. Completion requires the exact
canonical gate with live restricted Postgres, clean dependency audit/licence proof, staged secret
scan, pushed exact-SHA required CI, and the ledger command. Until then W3.3 remains unchecked.

**HUMAN GATE:** Fill `Approved-by` only after the repository owner approves this exact plan. Do not
implement runtime, dependency, test, Compose, or living-doc changes before that approval.

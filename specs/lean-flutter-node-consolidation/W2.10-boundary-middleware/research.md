# W2.10 research — ordered production boundary middleware

## Scope and approved boundary

W2.10 completes the standalone Node HTTP admission boundary without adding another service or
runtime dependency. It ports the Rust maintenance and rate-limit controls, makes trusted-proxy
identity explicit, and pins the already-local CORS, body limit, authorization, error redaction,
request tracing, and metrics behavior into one tested order.

This task does not add shared dependency deadlines (W2.12), graceful drain (W2.13), durable
credential-attempt state (W2.16), or WebSocket admission (W3.3). Login remains owner-gated off.

## Symbol and caller map

- Serena mapped `server/src/app.mjs::createApplication` and its process caller
  `server/src/main.mjs`. Construction is also exercised by the shell, lifecycle, readiness,
  no-secret-log, standalone, route-registry, and every through-Node parity process.
- `createApplication` already owns the 2 MiB global body ceiling, 16 MiB ASR overrides, literal
  non-credentialed CORS, local/proxy route registration, fixed NUL handling, generic 500 redaction,
  Fastify request logs, and `onResponse` metrics.
- Serena mapped `resolveActor` to every protected route. Authorization already occurs inside the
  route handler and therefore after request parsing/admission; changing it would affect all learner,
  teacher, scholar, ops, privacy, report, progress, session, review, ML, and agent transition paths.
- Serena mapped `createMetrics` only to the composition root. Its bounded route labels and latency
  histogram already count every response the app observes, including compatibility fallbacks.
- Serena mapped `proxy` to the compatibility catch-all and protected-handler delegation paths.
  Boundary middleware must inspect but never rewrite forwarded headers or bodies.
- The active Serena language server cannot resolve Rust. A read-only fallback mapped
  `platform_router_with_rate_limit`, `maintenance_guard`, and their integration tests in
  `services/platform-api/src/lib.rs`.

## Measured current state

Already local and retained:

- CORS is registered first; it uses a literal `*` or exact configured origins, never reflected
  credentials, and existing tests prove preflight interception and error-response headers.
- Fastify applies a 2 MiB body limit, while the two ASR routes declare 16 MiB overrides.
- bearer → pilot cookie → explicitly enabled development headers is the authorization order.
- expected API errors are shaped, NUL database errors receive a fixed 400, and unexpected errors
  return only `{"error":"internal error"}`.
- Fastify provides per-request structured tracing when logging is enabled; domain audit paths carry
  the caller's trimmed trace where required. The no-secret-log suite proves credentials/audio are
  not emitted even at trace level.
- `onResponse` records method, bounded matched path, status, and truncated millisecond latency.

Missing in Node:

- `MAINTENANCE_MODE` has no process parsing or global short-circuit.
- `DISABLE_RATE_LIMIT` and `TRUST_PROXY_HEADERS` affect Rust only. Node admits unbounded requests.
- no Node test proves the complete middleware order, positive refill/burst behavior, proxy-spoof
  resistance, or both body ceilings.

## Rust behavior and lean target

The Rust API is default-on at a 200 request burst and replenishes one request every 50 ms. CORS is
outermost; maintenance is immediately inside CORS and exempts only `/health`, `/ready`, and
`/metrics`; rate admission sits inside maintenance and before tracing/metrics/handlers. Rust's
proxy trust is opt-in because forwarded headers are spoofable when the service is directly exposed.

ADR-0050 additionally requires bounded key cardinality and eviction. The Node target therefore uses
a small package-owned token bucket with:

- capacity 200 and one token per 50 ms;
- a monotonic/injectable clock for deterministic refill tests;
- at most 10,000 client buckets and ten-minute idle eviction, followed by least-recently-used
  eviction if the cap is still full;
- fixed generic 429 output plus a bounded `Retry-After` value;
- Fastify's peer-derived `request.ip` by default; forwarded identity only when the operator enables
  `TRUST_PROXY_HEADERS`, with an explicit positive hop count (default one);
- no Redis/NATS and no authorization decisions derived from rate-limit state.

`DISABLE_RATE_LIMIT=1` remains the exact compatibility/test escape hatch used by the Rust harness.
Maintenance and proxy controls are read once at boot. Invalid/inert proxy-hop configuration must
refuse startup rather than silently weaken or misdescribe the boundary.

## Required assurance

- `middleware-order.test.mjs`: CORS preflight bypasses maintenance/rate admission; maintenance
  precedes rate and auth; 429/503 retain readable CORS headers; probes remain reachable in
  maintenance; metrics observe early outcomes.
- `tests/security/node-boundary.test.mjs`: bounded token bucket/refill/cardinality, forwarded-header
  spoof resistance and opt-in trusted proxy behavior, 2/16 MiB ceilings, generic unexpected-error
  redaction, generic auth refusal, and fixed rate/maintenance bodies.
- Existing shell, no-secret logging, authz, boot, direct parity, and through-Node parity remain
  green. The parity harness already sets `DISABLE_RATE_LIMIT=1`, so exhaustive behavior comparison
  is not turned into a load test accidentally.

# W2.10 plan — ordered production boundary middleware

**Status:** approved under the repository owner's W0–W7 consolidation approval<br>
**Architecture change:** implements ADR-0050's already accepted bounded HTTP admission boundary

## EARS acceptance criteria

1. WHEN maintenance mode is enabled, THE Node API SHALL return a fixed generic 503 for every path
   except exact `/health`, `/ready`, and `/metrics`, before rate admission or authorization, while
   retaining CORS headers. Tests: maintenance/order vectors.
2. WHEN CORS preflight is valid, THE Node API SHALL answer it before maintenance and rate admission
   and SHALL NOT spend a client token. Test: repeated preflight followed by exact-capacity requests.
3. WHEN a client exhausts its bucket, THE Node API SHALL return a fixed generic 429 with bounded
   retry guidance; WHEN sufficient monotonic time passes, THE bucket SHALL refill at one token per
   50 ms up to a capacity of 200. Tests: deterministic burst/refill vectors.
4. WHILE arbitrary client identities arrive, THE limiter SHALL retain no more than 10,000 buckets
   and SHALL evict idle/LRU state without an unbounded timer per client. Test: reduced-cap
   deterministic cardinality vector.
5. UNLESS trusted proxy handling is explicitly enabled, THE Node API SHALL derive admission
   identity from the socket peer and SHALL ignore spoofed forwarded IP headers. WHEN it is enabled
   with a valid hop count, THE API SHALL use Fastify's trusted-hop resolution. Tests: spoof and
   opt-in separation vectors.
6. IF proxy trust/hop configuration is invalid or inert, THEN process startup SHALL fail with a
   configuration error before listening. Tests: child-process boot guards.
7. WHEN a non-ASR JSON body exceeds 2 MiB, THE API SHALL refuse it with 413; WHEN the same body is
   under the ASR-specific 16 MiB ceiling, THE request SHALL proceed to authorization. Test: boundary
   body-limit vectors.
8. WHEN authorization fails or an unexpected exception occurs, THE API SHALL expose only the fixed
   public error contract and SHALL NOT return bearer material, database details, stack data, or the
   exception message. Tests: hostile auth/error vectors plus existing no-secret logging.
9. WHEN maintenance, rate admission, authorization, or a handler produces a response, THE metrics
   layer SHALL record its bounded route/status outcome, and request tracing SHALL remain outside
   domain work without logging raw audio or credentials. Tests: metrics/order and no-secret-log.

## Implementation tasks

1. Add red middleware-order and hostile boundary tests to canonical verification.
2. Add one dependency-free bounded token-bucket module with deterministic clock and cardinality
   controls.
3. Configure Fastify trusted-hop resolution at construction; install CORS, maintenance, and rate
   admission hooks in the approved order without mutating compatibility requests.
4. Parse maintenance/rate/proxy controls strictly in `main.mjs`; keep rate limiting default-on and
   preserve the exact `DISABLE_RATE_LIMIT=1` harness behavior.
5. Pin both body ceilings, fixed early-response bodies, generic error redaction, tracing/no-secret
   behavior, and early-response metrics.
6. Update ADR implementation notes and living architecture/testing/operations documentation.
7. Run focused tests, server type/build, the full live canonical gate, and a source-built production
   image with positive maintenance/rate controls. Record local evidence; do not check W2.10 until
   remote CI is green.

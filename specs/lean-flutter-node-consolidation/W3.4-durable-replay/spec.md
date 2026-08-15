# W3.4 specification — durable realtime replay authority

**Status:** approved for implementation under `plan.md`<br>
**Parent criterion:** RT-1<br>
**Primary proof:** `tests/realtime/replay-protection.test.mjs`

## Scope

W3.4 adds the missing durable single-use step to the internal Node realtime shadow. It claims a
hash of the signed ticket nonce in tenant-scoped Postgres after W3.3 validation/rate admission and
before WebSocket upgrade. Rust remains the public traffic target and compatibility oracle.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| RRP-1 | WHEN migration 0036 is applied fresh or after any supported legacy baseline, THE database SHALL contain one checksum-pinned replay-claim table with forced tenant RLS, a lower-case SHA-256 constraint, unique tenant/session/nonce claims, unsigned-64 expiry, deterministic cleanup index, restricted-role access, and tenant/session cascade ownership. | `tests/migrations/realtime-replay-migration.test.mjs`; migration runner/equivalence/restricted-role suites; SQL smoke |
| RRP-2 | WHEN independently pooled Node instances concurrently present the same valid ticket, THE replay authority SHALL atomically accept exactly one claim and classify every other claim as the same generic replay refusal; WHEN another signed session reuses the nonce, IT SHALL remain independently claimable. | concurrent/restart/scope cases in `tests/realtime/replay-protection.test.mjs` |
| RRP-3 | WHEN a claim is unknown, DB-expired, already consumed, or bound to another tenant/session/learner, THE Node process SHALL return an empty generic 401 before upgrade; WHEN Postgres errors, stalls, or is unavailable, IT SHALL return an empty bounded 503 before upgrade and SHALL NOT fall back to memory. | real upgrade, row-lock timeout, and injected failure cases in `tests/realtime/replay-protection.test.mjs`; ticket-boundary regression |
| RRP-4 | WHEN replay state is persisted or observed, THE system SHALL store/log/measure no raw ticket or nonce, SHALL pass no nonce to the admitted socket seam, SHALL expose only fixed-cardinality replay outcomes, and SHALL delete only DB-expired claims in bounded concurrent-safe batches while session privacy deletion cascades its claims. | hash-only/context/metrics/cleanup/privacy cases in both W3.4 suites; secret/log guards |
| RRP-5 | WHEN the Postgres authority is benchmarked through the restricted-role production claim path after warm-up with 512 unique claims at concurrency 32, IT SHALL produce zero incorrect outcomes, p95 latency below 100 ms, and throughput of at least 100 claims/s. | measured benchmark case in `tests/realtime/replay-protection.test.mjs` |
| RRP-6 | WHEN canonical verification and deployment topology are inspected, THE W3.4 migration and replay proof SHALL run exactly once; Node SHALL add no Redis/broker/runtime dependency or public traffic edge, and the Rust replay path SHALL remain unchanged for later canary/retirement. | `tests/contract/verify-invocations.test.mjs`; `tests/contract/realtime-decisions.test.mjs`; production/topology regression suites |

## Non-goals

- No frame/payload/session ceiling, audio queue, sequence, acknowledgment, storage, indexing,
  reconnect, client, public routing, traffic movement, or Rust retirement work from W3.5–W3.9.
- No new Redis service, NATS, security-definer replay function, privileged database role, package,
  image, or runtime dependency.
- No changes to ticket wire/HMAC fixtures, ticket issuance responses, Quran data, login policy,
  model output, learner feedback, or source/review gates.

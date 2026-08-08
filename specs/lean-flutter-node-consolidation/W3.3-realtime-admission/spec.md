# W3.3 specification — realtime admission and ticket parity

**Status:** proposed; implementation requires approval of `plan.md`<br>
**Parent criteria:** RT-1<br>
**Primary proof:** `tests/realtime/ticket-boundary.test.mjs`

## Scope

W3.3 replaces the Node realtime process's refusal-only upgrade boundary with strict, observable,
no-traffic-shadow admission. It validates the established Rust-generated ticket wire, browser and
native Origin policies, and bounded peer admission. It upgrades only an authorized request, then
closes it without consuming audio until W3.5 exists. W3.4 alone owns single-use replay.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| RTA-1 | WHEN realtime configuration is parsed, THE process SHALL require a non-empty tenant and a production-safe ticket secret, parse only canonical configured Origins, treat native no-Origin and trusted-proxy use as separate explicit policies, and reject invalid or inert settings before listen without returning a secret. | config/refusal cases in `ticket-boundary.test.mjs` and `process-lifecycle.test.mjs`; no-secret gate |
| RTA-2 | WHEN a ticket is presented for the audio route, THE admission boundary SHALL verify exact `rt_v2` signature bytes, session, tenant, non-empty signed retention, expiry, and a maximum 3,600-second remaining lifetime using one injected time observation; every failure SHALL be the same empty/generic 401 class. | all six Rust vectors plus hostile/tamper/boundary cases in `ticket-boundary.test.mjs`; existing Node/Rust vector suites |
| RTA-3 | WHEN a browser supplies Origin, THE boundary SHALL accept only an exact configured Origin; WHEN Origin is absent, IT SHALL reject unless the native policy is explicitly enabled; enabling native no-Origin SHALL NOT accept a disallowed, invalid, empty, or multiple Origin. | Origin matrix in `ticket-boundary.test.mjs`; shared Rust Origin oracle cases |
| RTA-4 | WHEN an otherwise admissible upgrade arrives, THE boundary SHALL consume a token from a default-on 200-burst/50-ms-refill bucket keyed by the direct peer unless an explicit bounded trusted-hop policy is enabled; IF empty, IT SHALL return 429 with bounded `Retry-After`, and forwarded-header rotation SHALL NOT bypass default admission. | deterministic bucket and real-upgrade proxy/rate cases in `ticket-boundary.test.mjs`; existing `node-boundary.test.mjs` |
| RTA-5 | WHEN the exact session-audio route has valid Origin, rate capacity, and claims, THE Fastify realtime process SHALL complete a real WebSocket 101 and synchronously hand only frozen claims plus nullable trace to its socket seam; until W3.5, the default seam SHALL close unavailable without reading, storing, forwarding, or acknowledging audio, and every other upgrade SHALL remain unavailable. | raw-handshake/real-WebSocket/close/path cases in `ticket-boundary.test.mjs`; updated lifecycle suite |
| RTA-6 | WHEN admission is observed or deployed as a shadow, THE system SHALL expose only fixed accepted/origin-rejected/rate-rejected/ticket-rejected counters, retain private metrics, persist/log no raw ticket or identity, publish no host port, and receive no Web/gateway traffic. | metrics/privacy/source/topology cases in `ticket-boundary.test.mjs`, `process-lifecycle.test.mjs`, and `production-image.test.mjs` |
| RTA-7 | WHEN canonical verification runs, THE Node admission suite and the Rust real-process hostile suite SHALL execute the same named hostile ticket corpus, and the W3.3 suite SHALL run exactly once. | shared hostile-case assertions; `verify-invocations.test.mjs`; `scripts/verify.sh` |

## Non-goals

- No replay record, nonce hash, migration, unique claim, TTL cleanup, Redis removal, or outage
  authority; those are W3.4 and must not be claimed here.
- No audio payload parsing, frame/session ceiling, queue, ack, storage, indexing, reconnect, public
  routing, client change, or Rust retirement.
- No mutation of Quran data, learner feedback, authentication policy, inference output, or RLS.

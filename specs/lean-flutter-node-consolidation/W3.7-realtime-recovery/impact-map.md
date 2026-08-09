# W3.7 impact map — realtime recovery and honest fallback

Serena is unavailable in this session. Exact definitions/imports/callers were mapped with `rg` and
read-only source inspection; every listed caller must stay green.

| Symbol/surface to touch | Direct callers and consumers | Planned effect | Regression obligation |
|---|---|---|---|
| new recovery-policy fixture/reference client | W3.7 E2E, chaos command, later Flutter W4.11 conformance | exact fresh-ticket/jitter/window/buffer/terminal behavior without a second product client | deterministic vectors, no overlapping/stale attempt, exact accounting, redaction |
| `finalizeSession` request adapter | route registry, Node/Rust parity harness, Flutter `ApiClient.finalizeSession`, background job store | authenticate before strict optional recovery parsing; only the owning learner may submit client-capture truth; report hash joins idempotency input | anonymous hostile body, staff legacy finalization, owner-only report, duplicate/conflicting retry |
| `authorizeFinalization` transaction/snapshot | durable job enqueue/retry/worker | authorize, row-lock, persist the first immutable report, and bind stored recovery state to job input | concurrent identical/different report, enqueue failure, and crash-retry proof |
| `prepareSessionFinalization` response | inference adapter, alignment writer, loss outcome table, session aggregate | read stored recovery truth and answer recording complete/incomplete/unverified separately from alignment finalization | consent/model/span/rollback parity plus source-separated server/client loss |
| migration 0038 session columns | session create/read/finalize, privacy export/delete, schema/smoke/inventory | constrained monotonic privacy-safe recovery truth on existing forced-RLS session row | checksum, fresh/upgrade convergence, constraints, RLS, cascade/export/delete |
| OpenAPI finalization schema | generated/future clients, route completeness, contract tests | optional exact request and explicit integrity response fields | strict schema and compatibility tests |
| chaos script | operators and W3.8 image proof | require acknowledged-or-accounted equality and API-issued fresh tickets | false-positive regression; no local token mint or send-count completion |
| ticket-authority relocation guard | chaos probe and all remaining local ticket-crypto callers | classify the probe as an API consumer, not a local minting caller | prove the probe cites the ticket API and imports neither current nor retired ticket authority |
| realtime decision guard | ADR-0051/0052 and architecture/testing living docs | pin honest ambiguity, source separation, Flutter deferral, and unchanged Rust traffic | fail if implementation notes drift into an exactly-once or end-to-end claim |
| verify/docs/evidence | local/CI gate, operators, W3.8/W3.9/W4.11 implementers | exact-one proof and explicit no-traffic/no-client-completion boundary | invocation, decision, topology, living-doc guards |

## Explicitly unaffected callers

- `server/src/realtime/{protocol,audio,admission,replay,main}.mjs` and shared ticket/ack fixtures keep
  byte-identical admission, replay, bounds, sequence, queue, and enqueue-ack semantics.
- `apps/flutter/**` stays on the one-ticket legacy recorder until W3.8 freezes frame/rate and W4.11
  implements the recovery vectors, UI states, consent/background handling, and physical evidence.
- `apps/web/**` remains a temporary reference scheduled for deletion; W3.7 does not invest in its
  incompatible MediaRecorder format or misleading drop-oldest fallback.
- Rust remains the public traffic target/oracle. No proxy, Compose, service, image, route set,
  dependency, Quran data, AI-feedback, auth/login, retention vocabulary, or model boundary changes.

## Parallel-work reservation

- Reserve migration 0038/manifest and migration tests, finalization route/workflow tests, the W3.7
  fixture/E2E/chaos/gate files, and W3.7 docs.
- The remote privacy fixes do not currently overlap these paths. Fetch and compare before each
  slice; if a parallel branch touches a reserved file, inspect/re-map and merge intent without
  overwriting or reverting unrelated work.

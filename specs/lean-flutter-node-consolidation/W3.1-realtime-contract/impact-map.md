# W3.1 impact map — realtime decision and protocol fixtures

Serena is unavailable; callers below were resolved with exact `rg` references and source reads.

| Symbol/file to touch | Direct callers and consumers | Planned effect | Regression proof |
|---|---|---|---|
| `specs/node-backend-port/fixtures/ticket-vectors.json` | Node ticket-vector test; Rust shared-ticket `vectors()` and count test; Rust generator; source/spec references | move once to contracts fixture root; no second copy or changed expected ticket | protocol fixture test + both Rust vector tests |
| `server/src/lib/ticket.mjs` ticket comment/path and unsigned-64-bit mint guard | recitation ticket route, gateway/E2E/smoke/parity tests, future realtime protocol | preserve all valid crypto/wire bytes; point at final fixture authority; refuse negative or above-`u64` BigInt expiries Rust cannot parse | Node vectors + API parity + gateway smoke |
| `services/shared-ticket::ticket_vectors::{vectors,rust_reproduces_every_committed_vector,every_committed_vector_validates_against_this_implementation}` | shared-ticket crate gate; platform-api issuer; realtime-gateway validator | change fixture path only | `cargo test` shared-ticket |
| `services/shared-ticket/tests/regenerate_vectors.rs::regenerate` | operator-only ignored generator | write the moved path; retain Rust-only generation | generator compile + fixture parity |
| `AudioIngressAck` / `serialize_ack` | `handle_audio_socket`; start-conflict, accepted, channel/backpressure, invalid-chunk acks; smoke/Web consumers | assert language-neutral objects; no runtime branch change | Rust ack vectors + real gateway smoke |
| new `server/src/realtime/protocol.mjs` | W3.2/W3.5 future realtime entrypoint; protocol fixture tests | one strict ack builder/validator; reuses ticket module, no duplicate crypto/socket | protocol fixture positive/refusal cases |
| Web `GatewayAudioAck` / `parseGatewayAudioAck` | `startGatewayAudioUpload`; `PlatformCommand` ack state/count; live-recitation/App smoke tests | consume fixture; validate nullable trace and safe sequence; never interpret message prose | Web live-recitation + App smoke |
| `specs/cutover/boundary.md` fixture citation | `tests/contract/boundary-references.test.mjs` resolves every cited evidence path | replace the moved fixture citation so the security-review package remains checkable | boundary-reference contract |
| historical fixture references under `specs/node-backend-port` and `specs/migration-completion` | migration researchers and reviewers locating the still-authoritative vectors | update only the moved path and generator instruction; preserve historical decisions | protocol authority/path test + reference search |
| `server/package.json` lint inputs | `tests/node-api/standalone-lifecycle.test.mjs` exact command pin; server build and canonical `pnpm build` | include `src/realtime/*.mjs` so the new protocol module is syntax-checked outside its direct test; update the exact lifecycle caller | lifecycle + server lint/build + protocol fixture test |
| `docs/DECISIONS.md` ADR-0051 and living architecture/testing | W3.2–W3.9 implementers, operators, W7 retirement | accept one realtime process/replay/backpressure boundary and explicit proof gates | realtime decision guard |
| `scripts/verify.sh` Node/Rust/Web invocations | local/CI canonical gate | run each new suite exactly once | verify-invocations guard + canonical gate |

## Explicitly unaffected

`server/src/routes/recitation.mjs::createRealtimeTicket`, OpenAPI response shape, Flutter
`StreamingRecorder`, Redis behavior, Postgres migrations, Compose routing, canonical Quran data,
audio retention, and learner feedback gates do not change in W3.1.

# W3.1 specification — realtime decision and language-neutral wire fixtures

**Status:** proposed; implementation blocked until `plan.md` is approved<br>
**Parent:** approved lean Flutter + Node consolidation / W3.1 / RT-1

## Objective

Freeze the existing `rt_v2` ticket and `audio.ack` semantics outside any Rust-, Node-, or historical
spec-owned directory, accept the final realtime/replay/backpressure architecture, and make both the
Rust oracle and Node consumers prove the same fixtures before a Node WebSocket process is written.

## EARS acceptance criteria

- **RTC-1:** WHEN the realtime architecture is read, THE decision SHALL select a separate realtime
  entrypoint in the one Node package, Postgres nonce-hash replay authority subject to benchmark,
  bounded queues, explicit acknowledgments, fail-closed shared replay, and no new broker/runtime
  dependency. Test: `tests/contract/realtime-decisions.test.mjs`.
- **RTC-2:** WHEN either implementation issues or validates an `rt_v2` ticket, THE exact version,
  field order, UTF-8 HMAC bytes, boolean rendering, retention claim, full unsigned-64-bit expiry,
  and lowercase signature SHALL match every Rust-generated language-neutral vector. Tests:
  `tests/realtime/protocol-fixtures.test.mjs`; Rust `ticket_vectors` tests.
- **RTC-3:** WHEN an `audio.ack` document is serialized or parsed, THE object SHALL preserve the
  exact kind and snake-case fields, non-empty identities, non-negative integer sequence, boolean
  acceptance, nullable trace id, and non-empty diagnostic message; clients SHALL NOT branch on
  message prose. Tests: `tests/realtime/protocol-fixtures.test.mjs`; Rust ack-vector test; Web
  `liveRecitation.test.ts`.
- **RTC-4:** WHEN the fixture move completes, THE old transitional fixture path SHALL be absent and
  every executable reader/generator SHALL reference the single language-neutral path. Test:
  `tests/realtime/protocol-fixtures.test.mjs`.
- **RTC-5:** WHEN canonical verification runs, THE realtime decision and protocol-fixture suites
  SHALL each run exactly once. Test: `tests/contract/verify-invocations.test.mjs`.

## Non-goals

No WebSocket listener, database migration, replay store, queue, traffic switch, Rust removal,
Flutter reconnect, or production protocol version change is authorized by W3.1.

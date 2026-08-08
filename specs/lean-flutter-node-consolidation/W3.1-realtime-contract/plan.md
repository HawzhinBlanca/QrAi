# W3.1 plan — realtime decision and language-neutral wire fixtures

**Status:** APPROVED — implementation proceeds one task at a time<br>
**Approved-by:** Repository owner — explicitly approved by this persistent implementation goal.<br>
**Criteria:** `spec.md` RTC-1…RTC-5; parent RT-1

## Decision

Keep the deployed wire unchanged: `rt_v2` remains the ticket tag and `audio.ack` remains the ack
kind. Move the six Rust-generated ticket vectors—not copy them—to
`packages/contracts/fixtures/realtime/`, and add a Rust-oracle ack-vector document there. Ack
`message` is explicitly diagnostic prose; code may branch on `kind` and `accepted`, never message
text. `trace_id` is always present on the wire as string or null.

Accept ADR-0051: the one Node package gains an independently deployable realtime entrypoint;
Postgres is the proposed durable nonce-hash replay authority only after the W3.4 benchmark; raw
tickets are never stored. Bounded per-session queues and explicit acks are required. No Redis,
NATS, service mesh, or new runtime dependency is added by this decision or task.

## Implementation sequence

1. Add red protocol/decision/invocation tests. They require the final fixture root, exact six-vector
   ticket coverage, Rust/Node issue+validation parity, ack shape/semantic refusals, one ADR, and one
   canonical invocation each.
2. Add ADR-0051 and the minimal architecture/testing text. Record separate-process failure
   isolation, browser Origin versus explicit native no-Origin policy, fail-closed shared replay,
   Postgres benchmark gate, bounded queues, and diagnostic-only ack prose.
3. Move `ticket-vectors.json` with no regenerated ticket value. Update the Node reader, both Rust
   readers, the Rust generator, source comments, and surviving historical references to the single
   new path. Delete the old file; never leave two fixture authorities. The RTC-2 red test also
   requires the Node minter to refuse negative and above-`u64` BigInt expiries that Rust cannot
   parse; this preserves all valid wire bytes and corrects issue parity rather than changing wire.
4. Add Rust-generated `audio-ack-vectors.json`, a committed ignored generator, and a Rust assertion
   that serializes `AudioIngressAck` against it. Add `server/src/realtime/protocol.mjs` as a small
   strict ack construction/validation boundary; do not add a socket or duplicate ticket crypto.
   Exercise the Web parser against the same fixture and make `trace_id` explicit and nullable. Add
   the realtime module to the server package's explicit syntax-check inputs so direct tests are not
   its only build coverage.
5. Run focused Node/Rust/Web tests, `git diff --check`, then the exact live-stack
   `bash scripts/verify.sh`. Do not ledger-update without required remote CI. If remote CI exposes
   a missing declared test prerequisite or a newly published dependency advisory, preserve the
   affected gate: add a red prerequisite assertion, provision the tool for every consuming job,
   and pin the smallest patched same-major dependency without an audit suppression.

## Exact implementation surface

- Decision/docs: `docs/DECISIONS.md`, `docs/architecture/10-10-platform.md`, `docs/TESTING.md`.
- Fixtures: move `specs/node-backend-port/fixtures/ticket-vectors.json` to
  `packages/contracts/fixtures/realtime/rt-v2-ticket-vectors.json`; add
  `packages/contracts/fixtures/realtime/audio-ack-vectors.json`.
- Rust oracle: `services/shared-ticket/src/lib.rs`, its `tests/regenerate_vectors.rs`, and
  `services/realtime-gateway/src/lib.rs` plus one ignored ack generator.
- Node/Web: `server/package.json`, `server/src/lib/ticket.mjs`, new
  `server/src/realtime/protocol.mjs`,
  `tests/node-api/ticket-vectors.test.mjs`, `apps/web/src/lib/liveRecitation.{ts,test.ts}` and exact
  Web ack mocks affected by nullable `trace_id`.
- Gates: new `tests/realtime/protocol-fixtures.test.mjs`, new
  `tests/contract/realtime-decisions.test.mjs`, `tests/contract/verify-invocations.test.mjs`, and
  `scripts/verify.sh`. Required-CI proof repairs may also touch the existing Muaalem evidence test,
  `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, and the generated `pnpm-lock.yaml`; they must
  not weaken an assertion or add a runtime dependency. Historical text references change only
  where the moved path would be broken.

## Risks and rollback

- Fixture drift is a two-runtime outage. Rust remains the generator/oracle; expected tickets are
  never recomputed from Node. A failed move restores the single old path, not a copied fallback.
- JSON key order is not protocol meaning. Tests compare parsed objects and required key sets, while
  ticket HMAC strings remain byte-exact.
- Tightening the Web parser can reveal stale mocks; update only mocks that omit Rust's always-emitted
  `trace_id`, and preserve compatibility of real accepted/rejected acks.
- W3.1 creates no deployable behavior, so rollback is source-only. Rust gateway remains production
  owner and the Node HTTP canary is unaffected.

**APPROVAL RECORDED:** The repository owner approved this exact W3.1 plan through the persistent
implementation goal recorded above. Implementation remains bound to the sequence and proof gates.

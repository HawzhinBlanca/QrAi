# Impact map — gateway WebSocket hardening

Scope as approved (option A). Under **B** only §2 applies. Under **C**, §1.1 and §2.

---

## 1. Modified

### 1.1 `services/realtime-gateway/src/lib.rs` — `audio_ws` (G1)

**Callers: the route registration only.** The change is on the `WebSocketUpgrade` extractor, before
`on_upgrade`, so it affects the transport handshake and nothing downstream.

`handle_audio_socket` is untouched: `AudioChunk::new`'s 2 MiB check stays exactly where it is. The
two limits become **derived from one constant** rather than independently chosen — two limits that
could drift apart is precisely how this 8× gap appeared.

**The slack matters.** An exact cap would turn every 2 MiB + 1 frame from a clean
*"audio chunk too large"* ack into an abrupt transport close, replacing a good error with a worse
one. The cap sits above `MAX_CHUNK_BYTES` so the application keeps answering for near-miss frames and
the transport only stops the absurd ones.

### 1.2 `services/realtime-gateway/src/lib.rs` — `check_ticket` (G2)

**Callers: `audio_ws` only.** A new bound on `expires_at - now`, after signature verification and
alongside the existing expiry check, refused with the **same status as any other bad ticket** so it
distinguishes nothing to an attacker.

**Ordering matters here as it did in `specs/privacy-job-404/`:** the signature check stays first. A
lifetime check ahead of it would answer differently for an unsigned ticket than a signed one, which
is an oracle.

## 2. New

| path | what |
|---|---|
| `specs/gateway-ws-sweep/` | this spec |
| `tests/gateway/ws-hostile-input.test.mjs` | the committed sweep |

**The suite spawns a real gateway process**, unlike every existing gateway test, which drives the
router in-process via `tower::ServiceExt::oneshot`. That is deliberate and is the point: `oneshot`
never performs a WebSocket upgrade (`lib.rs` says so where `audio_ws` is defined), so **no existing
test exercises the transport layer at all** — which is why a 16 MiB transport limit sat unnoticed
under a 2 MiB application limit.

## 3. Read, not modified

- **`MAX_CHUNK_BYTES` and its comment** — the comment is the source of §1.1's argument and gets an
  amendment, not a rewrite: its reasoning was right and its conclusion was half-achieved.
- **`services/node-api/lib/ticket.mjs`** — used by the sweep to mint real tickets. Unchanged. That a
  Node signer produces tickets the Rust gateway accepts is Phase 7's result, reused here.
- **`scripts/smoke-gateway.mjs`** — read for the URL/ticket pattern. Unchanged; it covers ticket
  *rejection* end to end and this suite covers what happens after a ticket is accepted.

## 4. Not touched

- `MAX_CHUNK_BYTES` itself, the ML forwarding path, the Redis dedup path, the rate limiter.
- `REALTIME_TICKET_TTL_SECONDS` on the minting side — G2 is a gateway-side bound, deliberately
  independent of what the minter chooses.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **The transport cap is below a real chunk and live recitation breaks** | **every learner, immediately — this is the product's core loop** | derived from `MAX_CHUNK_BYTES`, which is 20× the largest realistic chunk (~92 KB); G1 asserts a full 2 MiB frame still connects |
| A near-miss frame loses its clean application error | a client author, debugging a worse message | the cap has slack; G1 asserts the *"audio chunk too large"* ack still fires above the app limit |
| The ticket clamp refuses a legitimate ticket | every learner starting a session | the bound is on *lifetime*, generously sized; a 300 s ticket is orders of magnitude inside it; G2 unit-tests the boundary |
| The lifetime check lands ahead of signature verification and becomes an oracle | nobody | §1.2; the signature check stays first |
| The new suite is flaky because it spawns a process | it gets muted, and the surface goes back to unasserted | it waits on `/health` rather than sleeping, and asserts liveness at the end rather than per-case |

## 6. What has no mitigation

**23 probes is not a proof.** It is one battery over the shapes I thought of, one connection at a
time. `research.md §6` lists what was not covered — concurrency, the ML path, Redis under failure,
TLS/proxy framing — and none of it is addressed here.

**And the measured impact of §1.1 is 1 MiB of RSS.** If the transport cap is expected to change any
number an operator watches, it will not.

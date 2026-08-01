# Plan — close the gateway's remaining WebSocket headroom

**Status: APPROVED 2026-08-01 — option A, both changes plus the regression net.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §7 answered **A**.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).

---

## 1. The result first: no vulnerability

23 hostile probes against a real gateway. **`/health` still OK, zero panics, 12 of 13 malformed
tickets rejected pre-upgrade**, and every frame case handled correctly by the application.

The 13th "failure" was **my probe being wrong**, not the gateway (`research.md §3`).

**Everything below is hardening.** Anyone reading this as a vulnerability report is reading it wrong,
and the tasks are sized accordingly.

## 2. Two pieces of headroom

### 2.1 The transport accepts 16 MiB; the application will never accept more than 2 MiB

`upgrade.on_upgrade(…)` sets no frame limit, so tungstenite's 16 MiB default applies. Every frame
below that is fully assembled and `to_vec()`-copied before `AudioChunk::new` refuses it.

**`MAX_CHUNK_BYTES`'s own comment already names this**, and is only half-true today: it closed the
*unbounded* case, but the materialization it worries about still happens for everything under
16 MiB. The 10 MB frame the comment cites as the motivating example is **still accepted by the
transport**.

**Measured impact is small** — 12 rejected 8 MiB frames moved RSS by 1 MiB (`research.md §4.1`). That
is why this is hardening and not a fix.

### 2.2 Nothing bounds a ticket's lifetime, though the repo clamps its sibling

`MintInvitationRequest` clamps invitation TTL to [1, 720] hours *"so an admin cannot mint an
effectively immortal invite."* Realtime tickets have no equivalent clamp on either side, and the
gateway accepts `u64::MAX`.

Narrow but real: the 300-second TTL is the whole mitigation for a leaked ticket, and nothing at the
gateway enforces that the window is short.

## 3. Scope — the decision for the approver

| option | what changes | note |
|---|---|---|
| **A — both, plus the regression net** ⭐ | cap the transport near `MAX_CHUNK_BYTES`; cap accepted ticket lifetime; commit the sweep | two small changes, and the sweep becomes permanent evidence |
| **B — regression net only** | commit the sweep; change no behaviour | defensible: nothing found is a vulnerability, and the net is the durable half |
| **C — transport cap only** | 2.1, skip the ticket clamp | the ticket clamp is the more speculative of the two |

**Recommendation: A.** Both changes are a few lines with no legitimate client affected (largest real
chunk ~92 KB; every minted ticket is 300 s). But **B is a genuinely reasonable answer** — the
strongest thing this sweep produced is the evidence, not the patches.

## 4. Tasks

### G1 — Cap the transport at the application's limit

`.max_frame_size(MAX_CHUNK_BYTES + slack)` and `.max_message_size(…)` on the upgrade, derived from
the constant rather than a second magic number — two limits that can drift apart is how this gap
appeared.

**Acceptance:** an over-limit frame is refused by the **transport** (close, no ack) rather than
assembled and refused by the application; a 2 MiB frame is still accepted; the existing
*"audio chunk too large"* ack still fires for sizes between the app limit and the new transport
limit, so the clean application-level error is not replaced by an abrupt close for near-miss frames.

### G2 — Refuse a ticket whose lifetime is implausible

A gateway-side maximum on `expires_at - now`, generous enough that no legitimate ticket is ever
refused (`REALTIME_TICKET_TTL_SECONDS` is 300; the cap should be far above it), and finite enough
that `u64::MAX` is not accepted.

**Acceptance:** a normal 300-second ticket connects; a `u64::MAX` ticket is refused; the refusal is
the same status as any other bad ticket, so it leaks nothing new. Unit-tested on the boundary, not
only end to end.

### G3 — Commit the sweep

`tests/gateway/ws-hostile-input.test.mjs`: the 13 ticket mutations, the frame-size ladder, the
protocol mutations, and a liveness check.

**This is the durable half.** Nothing in the repo currently asserts that a 100 000-character ticket
or a NUL byte in a ticket is rejected, that a text frame is ignored, or that the gateway survives any
of it.

**Acceptance:** the suite asserts the gateway is **alive at the end** and that **no probe panicked**
— a per-case assertion cannot catch a process that died on case 3.

## 5. Non-goals

- **Rate-limiting frames.** The tower limiter covers the upgrade, not post-upgrade frames. Whether
  that needs changing is a separate question with its own evidence, and this sweep did not gather it.
- **Concurrency testing.** `research.md §6` — one connection at a time; nothing here says what N
  simultaneous pumps cost.
- **The ML forwarding path or the Redis dedup path.**
- **Changing `MAX_CHUNK_BYTES`.** 2 MiB is 20× the largest realistic chunk and is not the problem.

## 6. Risks

| risk | mitigation |
|---|---|
| **The transport cap is set below a legitimate chunk and live audio breaks** | largest realistic chunk is ~92 KB against a 2 MiB app limit; the cap is derived from `MAX_CHUNK_BYTES`, not chosen independently; G1 asserts a 2 MiB frame still connects |
| **The near-miss frame stops getting a clean application error** and becomes an abrupt close | G1's acceptance requires the *"audio chunk too large"* ack to still fire between the app limit and the new transport limit — which is why the cap has slack rather than being exact |
| The ticket clamp refuses a legitimate ticket after a clock skew | the cap is on *lifetime*, generously sized, not on absolute time; a 300 s ticket is orders of magnitude inside it |
| This reads as a vulnerability report | §1, and `tasks.md` will restate that nothing found was one |

## 7. Question for the approver

**Scope: A (both changes + the net, recommended), B (net only), or C (transport cap only)?**

"Approved" alone means **A**.

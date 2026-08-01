# Gateway WebSocket sweep — Tasks

Scope approved 2026-08-01: **option A** — both changes plus the regression net. See
[`plan.md`](plan.md) §3.

`specs/nul-byte-5xx/` excluded this surface explicitly. **A panic or unbounded allocation here takes
down every connected learner at once**, not one request.

**Task-ID prefix `G`.** Checked against `C*`, `CU*`, `F*`, `FK*`, `K*`, `MIG*`, `N*`, `NB*`, `OC*`,
`P0.1…P7.6`, `PAR*`, `PJ*`, `S*`, `T*` — no collision.

---

## 🟢 The result, first: no vulnerability

23 hostile probes against a real gateway process — 13 ticket-string mutations, 7 frame sizes, 3
protocol mutations.

```
/health after 23 probes: OK
panic lines in stderr: 0
```

**12 of 13 malformed tickets refused before the upgrade.** Post-upgrade, every frame case was handled
correctly by the application: an empty frame refused by name, 2 MiB accepted, 2 MiB + 1 refused with
its size in the message, a text frame ignored, 50 rapid chunks all acked.

**The 13th was my probe being wrong, not the gateway.** A `u64::MAX`-expiry ticket opened, and my
probe called that "UPGRADE ACCEPTED with a bad ticket" — but I had signed it with the real secret and
it was not expired, so accepting it was correct. It led to G2 for a different reason.

Everything below is **hardening**. Reading it as a vulnerability report is reading it wrong.

---

## G1 — Cap the transport at the application's limit

The transport accepted **16 MiB** — axum/tungstenite's default — while `MAX_CHUNK_BYTES` is
**2 MiB**. Measured: 4/8/12/15/16 MiB frames were received **in full** and `to_vec()`-copied before
`AudioChunk::new` refused them; only 17 MiB was stopped by the transport.

**`MAX_CHUNK_BYTES`'s own comment already named this concern, and was only half-true:**

> "…closing an unbounded-size DoS: verified empirically that a 10 MB binary WebSocket frame was
> accepted with no size check at all — `bytes.to_vec()` materializes the whole frame in memory before
> this point…"

It closed the **unbounded** part. The remaining bound was 16 MiB, and the materialization it worries
about still happened for everything below that. The 10 MB frame it cites as the motivating example
was still being assembled — just refused a step later.

**Honest sizing:** 12 rejected 8 MiB frames moved RSS by **1 MiB**. No accumulation. This is
hardening, not a fix for an observed leak, and the spec says so rather than inflating it.

`MAX_WS_FRAME_BYTES` is **derived from `MAX_CHUNK_BYTES`** — two independently-chosen limits drifting
apart is how the gap appeared. The **+64 KiB slack is load-bearing**: an exact cap would turn every
2 MiB + 1 frame from a clean `audio chunk too large` ack into an abrupt transport close, replacing a
precise error with a worse one. Measured after the fix:

```
2 MiB               -> app-ack accepted=true
2MiB+1 (near miss)  -> app-ack accepted=false     <- still the clean application error
2MiB+64KiB (cap)    -> app-ack accepted=false
2MiB+65KiB          -> transport closed (1006)
4 MiB               -> transport closed (1006)
```

- [x] G1 — Transport cap — absurd frames stopped at the transport, near misses still answered.

---

## G2 — Refuse an implausible ticket lifetime

**Concrete, not theoretical.** `consumed_tickets` maps a ticket to its expiry, and `evict_expired`
retains anything with `expires_at > now`. A `u64::MAX` entry is therefore **never evicted** — one
permanent map entry per ticket, defeating the per-entry eviction added in `55c872e` for exactly the
purpose of keeping that map bounded. The lifetime is also handed to Redis as the dedup key's TTL.

**Not an auth control.** A far-future ticket is validly signed, so producing one already needs the
secret. This bounds the damage, and it matches a clamp the repo already has one file over:
`MintInvitationRequest` clamps invitation TTL to [1, 720] hours *"so an admin cannot mint an
effectively immortal invite"*. The sibling credential was clamped; this one was not.

The cap is **1 hour** against a 300-second minting TTL — 12× any legitimate ticket, so clock skew or
a slow handshake can never refuse a real learner. The check runs **after** signature verification, so
it answers identically for signed and unsigned tickets and distinguishes nothing.

Two Rust tests: the boundary on both sides (300 s, exactly at the cap, one second past, `u64::MAX`),
and `an_unbounded_expiry_would_never_be_evicted`, which asserts the consequence directly on the
eviction it defeats.

- [x] G2 — Ticket lifetime — bounded, after the signature, with the eviction consequence pinned.

---

## G3 — Commit the sweep

`tests/gateway/ws-hostile-input.test.mjs` (7 tests).

**This spawns a real gateway process, and no other gateway test does.** Every existing one drives the
router in-process via `tower::ServiceExt::oneshot`, which — as `audio_ws`'s own doc comment says —
**never performs a WebSocket upgrade**. So nothing exercised the transport layer at all, which is
precisely how a 16 MiB transport limit sat unnoticed beneath a 2 MiB application limit.

Three deliberate choices:

- **Fail, never skip**, if the binary is missing. A suite whose assertions vanish when a build step
  was forgotten prints green while guarding nothing.
- **Poll `/health` rather than sleeping.** A fixed sleep is how a process-spawning suite becomes
  flaky, then muted, then this surface goes back to unasserted.
- **A liveness test at the end.** A per-case assertion cannot catch a process that died on case 3 —
  every later case would fail for the wrong reason and the panic would be buried.

There is also a test asserting a **valid** ticket still connects. Without it the whole file could
pass against a gateway that refuses everything.

- [x] G3 — Regression net — real process, fail-not-skip, liveness asserted.

---

## Findings

### 1. The most valuable output is the negative result

Three sessions of sweeping have now produced: an FK class (4 fixed), a NUL byte class (16 surfaces),
and — here — **nothing**. That third answer is worth as much as the first two to the reviewer waiting
on `P1.7`, and it did not exist before: no test asserted that a 100 000-character ticket, a NUL in a
ticket, a cross-tenant signed ticket, or a text frame was handled at all.

### 2. A comment describing a fix is not the fix

`MAX_CHUNK_BYTES`'s comment states the materialization concern precisely and then stops one layer
short of it. Nothing was wrong with the reasoning; the conclusion was simply only 8/16ths achieved,
and the comment's confident tone is what made it read as finished. **Second time this session** — the
model-version fallback in `specs/fk-surface-sweep/` had the same shape.

### 3. 🟢 The ambiguity panic fired in the wild, on CI, on my own test

All seven tests failed on CI with *"the gateway never became healthy"* while passing locally.

`.github/workflows/ci.yml` exports `ALLOW_INSECURE_DEFAULTS=1` for the whole job. This suite inherits
`process.env` and adds `ALLOW_INSECURE_SECRETS=1` and `GATEWAY_ALLOW_MISSING_ORIGIN=1` — and
`enforce_legacy_alias` (`specs/insecure-defaults-split/`) **panics when the deprecated alias is set
alongside any per-control variable**, because there is no defensible way to combine them.

So the gateway refused to boot. **That is the guard doing exactly its job**, on the first
configuration that ever hit it — written four PRs ago with a unit test and an exit-101 demonstration,
and now proven against a real mixed configuration nobody constructed on purpose.

Fixed by clearing the alias in the spawned environment. Any future test that spawns these services
and sets a per-control variable must do the same, and the reason is in the code beside it.

### 4. My probe reported a false positive, and the writeup says so

The `u64::MAX` ticket was flagged "UPGRADE ACCEPTED with a bad ticket". It was a correctly-signed,
unexpired ticket, and accepting it was right. Carrying that forward as a finding would have
overstated the sweep; it is corrected in `research.md §3` rather than quietly dropped.

---

## Not done

- **23 probes is not a proof.** One battery over the shapes I thought of, **one connection at a
  time**. Nothing here says what N simultaneous pumps cost.
- **The ML forwarding path** and **the Redis dedup path under failure** were not probed.
- **Frame rate is not limited.** The tower limiter covers the upgrade, not post-upgrade frames.
  Whether that needs changing is a separate question this sweep did not gather evidence for.
- **Probed against a direct `ws://`** — nothing about TLS or proxy framing.

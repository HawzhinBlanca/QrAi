# Research — hostile-input sweep of the realtime gateway's WebSocket surface

Measured against `1b2a13e`. `specs/nul-byte-5xx/` excluded this explicitly: *"HTTP only. Nothing here
covers the realtime gateway's WebSocket frames."*

**A panic or unbounded allocation here takes down every connected learner at once, not one request.**

---

## 1. Method

A real `quran-ai-realtime-gateway` process, real HMAC tickets minted with the Phase-7 Node signer
(`server/src/lib/ticket.mjs`), and Node's built-in `WebSocket`. 23 probes:

- **13 ticket-string mutations**, pre-upgrade
- **7 frame sizes**, post-upgrade on a valid ticket
- **3 protocol mutations** — a text frame where audio belongs, 50 rapid chunks, immediate close
- Then: is `/health` still answering, and did anything panic?

## 2. 🟢 The headline: it held

```
/health after 23 probes: OK
panic lines in stderr: 0
```

**12 of 13 malformed tickets were rejected before the upgrade** — empty, wrong prefix, too few parts,
too many parts, a 100 000-character ticket, a NUL byte, a negative expiry, a non-numeric expiry, a
non-boolean consent flag, a wrong-length signature, a non-hex signature, and a Unicode session id.

Post-upgrade the application behaved correctly on every frame: an empty frame was refused
(*"audio chunk must contain bytes"*), 1 byte and exactly 2 MiB accepted, 2 MiB + 1 refused by name
(*"audio chunk too large: 2097153 bytes"*), a text frame ignored, 50 rapid chunks all acked,
immediate close handled.

**No vulnerability was found.** What follows is two pieces of headroom, stated at their real size.

## 3. The 13th ticket is a false positive in my probe, not a finding

`expiresAtUnixSeconds = u64::MAX` **opened**. My probe labelled that "UPGRADE ACCEPTED with a bad
ticket". It is not a bad ticket: I signed it with the real secret, and it is not expired. Accepting
it is correct.

It does raise §5, but the probe's own verdict was wrong and is corrected here rather than carried
forward as a finding.

## 4. 🟠 The transport accepts 8× what the application will ever use

Measured precisely:

| frame | outcome |
|---|---|
| 2 MiB | accepted by the application |
| 4, 8, 12, 15, 16 MiB | **received in full**, then refused by `AudioChunk::new` |
| 17, 20 MiB | closed by the **transport** (1006) |

So the transport limit is **16 MiB** — axum/tungstenite's default `max_frame_size` — while
`MAX_CHUNK_BYTES` is **2 MiB**. `audio_ws` calls `upgrade.on_upgrade(…)` with no
`.max_frame_size()` / `.max_message_size()`.

**The existing comment on `MAX_CHUNK_BYTES` already states this concern, and it is only half-closed:**

> "Cap at 2 MB (20x+ headroom) so no legitimate chunk is ever rejected, while closing an
> unbounded-size DoS: verified empirically that a 10 MB binary WebSocket frame was accepted with no
> size check at all — `bytes.to_vec()` materializes the whole frame in memory before this point…"

The cap closed the **unbounded** part. The remaining bound is 16 MiB, not 2 MiB, and the
materialization the comment worries about **still happens** for everything below 16 MiB — the frame
is fully assembled and `to_vec()`-copied before the check runs. A 10 MB frame is still accepted by
the transport today; it is just refused a step later.

### 4.1 …and the practical impact is small, which the comment could not know

```
RSS before: 133 MiB
RSS after 12x 8 MiB frames the app REJECTS: 134 MiB  (delta 1 MiB)
```

No accumulation — the allocator reclaims promptly. **This is hardening, not an active
vulnerability**, and saying otherwise would be inflating it.

Largest realistic chunk is ~92 KB (480 ms of 48 kHz stereo 16-bit PCM, from the same comment), so
2 MiB is already 20× headroom. Capping the transport near the application limit costs no legitimate
client anything.

## 5. 🟠 Nothing bounds a realtime ticket's lifetime — and the repo already clamps its sibling

The gateway accepts any expiry a validly-signed ticket carries, including `u64::MAX`. The minting
side uses `REALTIME_TICKET_TTL_SECONDS = 300`, so no legitimate ticket has a far-future expiry.

**There is already a precedent for exactly this clamp, one file over.** `MintInvitationRequest`:

> "Validity window in hours; defaults to 168 (7 days), **clamped to [1, 720] so an admin cannot mint
> an effectively immortal invite.**"

Pilot invitations are clamped against immortality; realtime tickets are not — on either side. The
consequence is narrow but real: the 300-second TTL is the mitigation for a ticket leaking into a log,
a proxy or browser history, and today nothing in the *gateway* enforces that the window is short. A
ticket minted with a far-future expiry — by a leaked secret, or by a bug on the minting side — is
accepted for as long as it exists.

**Not an auth bypass.** Anyone who can produce such a ticket already holds the signing secret.

## 6. What this sweep did not cover

- **The ML forwarding path.** Frames are forwarded to `ml_inference_url`; the ML service's own input
  handling was not probed.
- **Concurrency.** One connection at a time. Nothing here says what N simultaneous 16 MiB pumps cost.
- **The Redis ticket-dedup path** under failure.
- **TLS/proxy framing.** Probed against a direct `ws://`.

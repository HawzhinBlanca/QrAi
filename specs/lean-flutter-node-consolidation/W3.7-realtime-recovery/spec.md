# W3.7 specification — realtime recovery and honest fallback

**Status:** approved for implementation under `plan.md`
**Parent criterion:** RT-3
**Primary proof:** `tests/e2e/realtime-recovery.test.mjs`

## Scope

W3.7 freezes and proves the recovery contract that the final Flutter client will implement in
W4.11. It adds truthful client-capture recovery state to the existing Node finalization boundary and
replaces the misleading Rust-only chaos claim with a real Node reference client. It does not move
traffic or build more React code. The v1 binary/ack wire remains unchanged, so ambiguity fails closed
instead of pretending exactly-once replay.

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| RRF-1 | WHEN a recovery-capable client initially connects or reconnects, THE policy SHALL mint a fresh single-use ticket for every attempt, SHALL use equal jitter with a 500 ms base, 15,000 ms cap, and six-attempt ceiling, SHALL never run overlapping attempts, and SHALL reset the incident only after a valid accepted acknowledgement rather than a transport open. | deterministic fresh-ticket/jitter/rapid-open-close/stale-callback cases in `tests/e2e/realtime-recovery.test.mjs`; ticket/replay regressions |
| RRF-2 | WHILE a socket is unavailable or one frame awaits acknowledgement, THE client contract SHALL retain FIFO audio within both 125 chunks and 2,097,152 bytes, SHALL permit at most one in-flight frame, and SHALL stop before accepting another frame if either ceiling would be exceeded; it SHALL NOT silently drop oldest or newest audio. | chunk/byte/window/overflow/long-audio memory cases in `tests/e2e/realtime-recovery.test.mjs` |
| RRF-3 | WHEN a strict acknowledgement is accepted, THE client contract SHALL retire exactly the matching FIFO frame; WHEN it is rejected, THE same frame SHALL remain recoverable without advancing client progress; IF an acknowledgement is malformed, foreign, out of order, or a disconnect leaves a sent frame ambiguous, THEN THE contract SHALL NOT replay it on v1 and SHALL enter a terminal degraded state with exact uncertain/lost counts. | accepted/rejected/malformed/foreign/order/ambiguous-disconnect cases; shared ack fixture regressions |
| RRF-4 | IF retry exhaustion, buffer overflow, acknowledgement ambiguity, or capture/device failure occurs, THEN THE recovery controller SHALL stop capture once, close the socket, cancel pending retry work, explain that the recording is incomplete, and invoke session finalization exactly once with a bounded closed recovery report. | terminal-state/race/idempotent-stop/finalize-once/diagnostic-redaction cases in `tests/e2e/realtime-recovery.test.mjs` |
| RRF-5 | WHEN finalization receives a recovery report, THE Node boundary SHALL authenticate before parsing, SHALL accept reports only from the owning learner, SHALL accept only exact versioned state/reason and safe captured/acknowledged/dropped/uncertain counts satisfying `captured = acknowledged + dropped + uncertain`, SHALL derive tenant/learner/session from authorization, SHALL store the first report immutably on the owning session under RLS, and SHALL reject audio, transcript, credentials, identities, arbitrary text, extra keys, invalid accounting, a conflicting retry, or a claimed complete state with loss; authorized staff MAY still finalize through the legacy empty body. | live Postgres request/schema/RLS/idempotency/conflict/hostile-body/auth-order/owner-only cases in `tests/e2e/realtime-recovery.test.mjs` and `tests/api-parity/session-finalize-parity.test.mjs`; migration proof |
| RRF-6 | WHEN finalization answers, THE response SHALL distinguish alignment work (`finalized`) from recording integrity (`recordingStatus=complete|incomplete|unverified`), SHALL return client dropped/uncertain and durable server lost counts as separate sources, SHALL NOT fabricate a deduplicated or summed total because v1 has no shared chunk identity, and SHALL never advertise a complete recording while either source is degraded or the client report is absent. | complete/incomplete/unverified/retry/server-loss/client-loss/source-separation cases in `tests/e2e/realtime-recovery.test.mjs`; finalization parity regressions |
| RRF-7 | WHEN the real Node reference client is forced through clean drops, repeated refusal, overflow, and a simulated ten-minute stream, THE proof SHALL require every non-ambiguous chunk to be acknowledged or explicitly counted, remain within declared memory/count bounds, use fresh API-issued tickets, and finalize honestly; canonical verification SHALL run the W3.7 proof exactly once without changing public traffic, packages, services, or the frozen wire. | live chaos/long-audio cases; `tests/contract/verify-invocations.test.mjs`; topology/decision/package guards |

## Non-goals and stop conditions

- No claim of exactly-once recovery on v1. A client-generated idempotency key would require an
  approved versioned protocol change and belongs after the W3.8 format decision.
- No Flutter production recorder/UI/device edit in W3.7. W4.11 must implement these exact vectors,
  consent-preserving lifecycle, localized learner states, background/offline handling, and physical
  network-loss evidence. No React hardening is authorized because that client is being retired.
- No new batch-audio upload route. “Fallback” means stop capture, preserve/report bounded recovery
  truth, and invoke the existing idempotent finalizer; it does not invent a second audio writer.
- No Rust change, traffic/canary change, PCM codec/rate assumption, inference/model/eval change,
  canonical Quran mutation, login/auth posture change, new dependency, broker, service, or port.

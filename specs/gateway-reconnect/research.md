# Research — gateway WebSocket reconnect for live recitation upload

## Symbols (grounded via read + grep, no other callers found)
- `startGatewayAudioUpload(options, environment)` — `apps/web/src/lib/liveRecitation.ts:125`.
  Opens one `WebSocket`, wires `onopen/onclose/onerror/onmessage`, returns a
  `GatewayUploader { sendChunk, close }` or `null` if unsupported. On `onerror` it calls
  `options.onStatusChange("error")` + `onError(...)`; on `onclose` it calls
  `onStatusChange("closed")`. Neither handler retries — the function's job ends once the
  socket is created; there is no internal reconnect loop today.
- `GatewayUploadStatus` — `"idle" | "connecting" | "connected" | "unavailable" | "error" | "closed"`
  (`liveRecitation.ts:26`). No `"reconnecting"` state exists yet.
- `GatewayUploader.sendChunk(chunk)` (`liveRecitation.ts:157-164`) — returns `false` silently
  when `socket.readyState !== OPEN` or the chunk has no blob. Caller (`PlatformCommand.tsx:339`)
  ignores the return value.
- Only caller of `startGatewayAudioUpload` / consumer of `GatewayUploader`:
  `LiveAlignmentCard` in `apps/web/src/components/PlatformCommand.tsx:271-415`.
  - `uploaderRef` (line 281): holds the current `GatewayUploader`.
  - `gatewayStatus` state (line 292), rendered read-only via `formatGatewayStatus` (line 374,
    436-450) — a static label, no action bound to any status value.
  - `handleCaptureToggle` (line 305): the only place `startGatewayAudioUpload` is called, only
    on manual mic-start. Stop path (line 306-311) closes the uploader and nulls the ref, but
    there is no equivalent path that runs on `gatewayStatus === "error" | "closed"` while
    `captureRef.current` (mic) is still active.
  - `onChunk` (line 338-341): calls `uploaderRef.current?.sendChunk(chunk)` unconditionally for
    every mic chunk, regardless of `gatewayStatus`. `sendChunk` fails closed (returns `false`,
    drops the chunk) once the socket isn't OPEN, but nothing observes that return value, so
    chunks are silently dropped for the remainder of the session once the socket drops.
  - `captureStatus`/`isRecording` are driven only by the mic (`MediaRecorder`), independent of
    `gatewayStatus` — confirms the bug: a dead gateway socket never affects the "Streaming"
    label or the mic capture loop.

## Confirmed behavior (matches the reported bug)
1. Socket drops (network blip / gateway restart) → `onclose`/`onerror` fire → `gatewayStatus`
   becomes `"closed"`/`"error"`. No reconnect attempt, no ref reset.
2. Mic capture (`captureRef`) is unaffected — `recorder.ondataavailable` keeps firing,
   `onChunk` keeps calling `uploaderRef.current.sendChunk(chunk)`.
3. `sendChunk` on a closed socket returns `false` and does nothing else — chunk is dropped,
   `audioChunks` state (client-side counter) still increments because `setAudioChunks` runs
   unconditionally in `onChunk` regardless of `sendChunk`'s return value.
4. UI shows `captureStatus = "recording"` ("Streaming") and a static `Gateway closed`/
   `Gateway error` label side by side, with no indication that recitation data is not
   reaching the server and no escalation/retry.

## Existing conventions to reuse
- `GatewayUploadEnvironment`/dependency-injected `WebSocket` pattern already exists and is
  exercised via `FakeWebSocket` in `liveRecitation.test.ts` (lines 14-38) — reconnect tests
  should extend this fake rather than introduce a new mock style.
- `isStartingCaptureRef` in `PlatformCommand.tsx` (line 289) is the existing precedent for a
  synchronous re-entry guard ref to prevent overlapping async start attempts — the same
  pattern applies to guarding overlapping reconnect attempts.
- No existing retry/backoff utility elsewhere in `apps/web/src/lib` — this would be new.

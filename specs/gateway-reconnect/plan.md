# Plan — auto-reconnect + escalated UI for the live recitation gateway socket

## Acceptance (EARS)
- WHEN the gateway WebSocket closes or errors while the uploader has not been deliberately
  closed, THE uploader SHALL attempt to reopen a new socket to the same URL with exponential
  backoff, up to a bounded number of attempts, without the caller having to recreate the
  uploader or rewire any ref.
- WHILE a reconnect attempt is pending, THE gateway status SHALL be `"reconnecting"` (a new
  `GatewayUploadStatus` member), distinct from the terminal `"error"`/`"closed"` states.
- WHEN reconnect attempts are exhausted, THE status SHALL settle on `"error"` and `onError`
  SHALL report that the connection was lost and chunks are not reaching the server.
- WHEN `GatewayUploader.close()` is called deliberately (mic stopped, component unmounted),
  THE uploader SHALL NOT schedule or continue any reconnect attempt or timer.
- WHEN the gateway is `"reconnecting"` or terminally `"error"`/`"closed"` while the mic is
  still recording, THE console SHALL show a distinct, non-static warning (not just the plain
  status label) so the operator knows recitation audio may be getting dropped.
- WHEN `LiveAlignmentCard` unmounts while capture/upload is active, THE mic stream and gateway
  socket (and any pending reconnect timer) SHALL be torn down (currently there is no unmount
  cleanup at all — a pre-existing gap this change must not leave dangling for the new timers).

## Tasks (each: edit -> `bash scripts/verify.sh` green)
1. **`apps/web/src/lib/liveRecitation.ts`**
   - Add `"reconnecting"` to `GatewayUploadStatus`.
   - Add optional `maxReconnectAttempts` (default 5) and `baseReconnectDelayMs` (default 500,
     doubling per attempt, capped at 8000ms) to `StartGatewayUploadOptions`.
   - Rework `startGatewayAudioUpload` to own a mutable `socket` reference and a
     `connect()` inner function that wires `onopen/onclose/onerror/onmessage`; `onopen` resets
     the attempt counter to 0. `onclose`/`onerror`, when the close was not caused by the
     returned `close()` (track via a `manualClose` flag), increment the attempt counter and:
     - if attempts remain: `onStatusChange("reconnecting")`, `setTimeout` with backoff, then
       call `connect()` again against the same URL;
     - else: `onStatusChange("error")` + `onError("Realtime gateway connection lost after N
       attempts — recitation audio is not reaching the server.")`, no further retries.
   - `close()` sets `manualClose = true`, clears any pending reconnect timer, and closes the
     current socket.
   - `sendChunk` unchanged (still returns `false` off an unusable socket) — dropped-chunk
     accounting stays a UI concern, not a lib concern.
2. **`apps/web/src/components/PlatformCommand.tsx`**
   - `formatGatewayStatus`: add the `"reconnecting"` case (TS exhaustiveness — the switch has
     no `default`, so this is required for `verify.sh`'s typecheck to pass regardless).
   - Render a distinct warning line (not just the status label) when
     `isRecording && (gatewayStatus === "reconnecting" || gatewayStatus === "error" ||
     gatewayStatus === "closed")`, e.g. "Recitation audio is not reaching the server" /
     "Reconnecting to gateway…".
   - Add a `useEffect` unmount cleanup that closes `captureRef.current` and
     `uploaderRef.current` if still set — there is none today, and the new reconnect timers
     make that gap worse (a timer could fire after unmount without it).
3. **Tests (`apps/web/src/lib/liveRecitation.test.ts`)**, using `vi.useFakeTimers()` and the
   existing `FakeWebSocket`, extended to let a test grab each successive instance:
   - mid-session `onclose` -> status goes `"reconnecting"` -> after the backoff timer fires a
     *new* `FakeWebSocket` instance is created to the same URL -> that instance's `onopen`
     fires -> status goes back to `"connected"` and `sendChunk` works again on the new socket.
   - repeated failures exceeding `maxReconnectAttempts` -> status ends on `"error"`, `onError`
     fires with a "not reaching the server" message, and no further `FakeWebSocket` instances
     are created after the last attempt.
   - calling the returned `close()` while a reconnect timer is pending prevents any further
     `FakeWebSocket` instance from being created (asserts the manual-close guard + timer
     clear).
4. **Verify**: `bash scripts/verify.sh` green; re-read the diff against
   `impact-map.md` below to confirm both callers were updated consistently.

## Non-goals
- No change to `sendChunk`'s fire-and-closed-fails-silently contract, and no new
  dropped-chunk counter/telemetry — the task only asks for reconnect + status escalation.
- No change to `apps/mobile` (not in the pnpm workspace, not gated, does not reference this
  module per the impact-map grep).

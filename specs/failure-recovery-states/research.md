# Research: Failure and Recovery States

## Objectives
- Assert correctness of system behavior under network-loss/failure states:
  1. Audio chunk upload retry in the gateway: when the ML service returns transient errors or fails to respond, the gateway performs bounded retries with backoff.
  2. WebSocket disconnect / error handling in the browser: when the gateway WebSocket connection fails or terminates, the browser transitions the gateway status to `error` / `closed` and triggers error handling without locking up.
  3. Offline guided fallback: when the platform API is unreachable, the learner home displays the `OfflineBanner`, uses offline cached Quran surahs, saves progress offline fallback, and continues guided practice mode.

## Research Findings
- **Realtime Gateway Retry Logic**:
  - Located in [lib.rs](file:///Users/hawzhin/QrAi/services/realtime-gateway/src/lib.rs#L851-L890).
  - Handles forwarding of audio chunks to `ml-inference` with bounded retry loops (up to 3 attempts) and backoff delays (`100ms * attempt`).
  - Correctly records telemetry metrics on final failure.
- **Frontend WebSocket Error / Close Handling**:
  - Located in [liveRecitation.ts](file:///Users/hawzhin/QrAi/apps/web/src/lib/liveRecitation.ts#L135-L146).
  - Sets the `onclose` and `onerror` handlers of the WebSocket object to update status and trigger the appropriate client-side callback.
- **Verification Coverage**:
  - Added unit test cases to [liveRecitation.test.ts](file:///Users/hawzhin/QrAi/apps/web/src/lib/liveRecitation.test.ts) verifying the status transitions to `error` on failure and `closed` on disconnect.
  - The frontend smoke tests in [App.smoke.test.tsx](file:///Users/hawzhin/QrAi/apps/web/src/App.smoke.test.tsx) verify the entire application remains functional and fails gracefully when the backend services are offline.

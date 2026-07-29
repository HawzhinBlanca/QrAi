# Failure and Recovery States Plan

Verify the recovery states and error handling for WebSocket connection loss and offline mode.

## Proposed Changes

### Tests

#### [MODIFY] [liveRecitation.test.ts](file:///Users/hawzhin/QrAi/apps/web/src/lib/liveRecitation.test.ts)
- Already added tests to verify that the `startGatewayAudioUpload` client handles `onerror` and `onclose` events correctly, updating status to `error` and `closed`.

## Verification Plan

### Automated Tests
- Run vitest suite:
  ```bash
  pnpm --filter @quran-ai/web test
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```

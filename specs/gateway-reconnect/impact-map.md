# Impact map — gateway reconnect

Grep across `apps/` and `packages/` for `startGatewayAudioUpload|GatewayUploader|
GatewayUploadStatus|liveRecitation` found exactly these files (no other callers, no
`apps/mobile` reference since it's outside the pnpm workspace / not gated):

- `apps/web/src/lib/liveRecitation.ts` — defines all touched symbols. Direct edit target.
- `apps/web/src/lib/liveRecitation.test.ts` — existing unit tests for this module; extend for
  the reconnect + manual-close-cancels-timer cases. Existing tests
  ("returns an unavailable gateway uploader...", "sends audio blobs only after the gateway
  websocket is open...") must keep passing unmodified — the new behavior is additive
  (`onclose`/`onerror` gains a retry path only when not manually closed; a single successful
  `onopen` with no subsequent close, as in the existing test, is unaffected).
- `apps/web/src/components/PlatformCommand.tsx` (`LiveAlignmentCard`) — sole runtime consumer.
  `formatGatewayStatus`'s switch has no `default`, so adding `"reconnecting"` to
  `GatewayUploadStatus` without adding a matching case is a compile error under
  `pnpm typecheck` / `verify.sh` — task 2 is not optional cleanup, it is required for the
  build to pass once task 1 lands.

No other module imports from `liveRecitation.ts`; no contracts package or backend service
touches `GatewayUploadStatus`/`GatewayUploader` (they are web-only client types, not part of
`packages/contracts`). No database, RLS, or audio-retention surface is touched — this is a
client-side connection-resilience change only.

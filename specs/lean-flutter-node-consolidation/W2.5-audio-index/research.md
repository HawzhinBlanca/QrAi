# W2.5 research — local Node audio chunk indexing

## Relevant symbols and current flow

- Rust oracle: `services/platform-api/src/handlers/recitation.rs::index_audio_chunk` handles
  `POST /v1/audio-chunks`; Rust symbols were unavailable to Serena because this session exposes only
  the TypeScript language server, so the ignored Rust file was inspected read-only.
- Gateway caller: `services/realtime-gateway/src/lib.rs::handle_audio_socket` stores a chunk in
  ML first, then POSTs `{sessionId,chunkId,startMs,endMs,sampleRate,objectKey}` with the original
  `x-realtime-ticket`; 4xx is permanent, 5xx/network is retried three times, and failure is counted.
- Node composition: `server/src/routes/index.mjs::ROUTES` has 37 routes and omits audio indexing;
  `server/src/main.mjs::PORTABLE` therefore omits it too. `server/src/app.mjs::createApplication`
  already supplies `ctx.db` and `ctx.ticketSecret` to every handler.
- Node domain target: `server/src/routes/recitation.mjs` currently exports only
  `createRealtimeTicket`; it already owns the matching issuer and DB consent/session join.
- Ticket utility: `server/src/lib/ticket.mjs::verifyRealtimeTicket` proves only version/part count
  and constant-time HMAC equality. It does not parse claims, bind a session, or reject expiry.
- DB boundary: `server/src/lib/db.mjs::withTenant` reserves one transaction, sets the transaction-
  local tenant GUC, and bounds statements. `audio_chunks.id` is globally unique; span/sample/status
  checks live in `infra/migrations/0001_core_schema.sql`.

## Oracle behavior to preserve

- Missing, malformed, expired, wrongly signed, and wrong-session tickets all answer the same 401.
- Ticket claims supply tenant/session/learner/retention; caller tenant/learner fields have no authority.
- A usable span is integer int4 data with `0 <= startMs < endMs`; invalid spans are 400.
- The tenant-scoped session must still exist; otherwise 404. Its audit event is reused per chunk.
- Inserted rows use `evidence_id=chunkId`, default sample rate 16000, status `aligned`, and exact object
  key; exact retries answer 200 and do not duplicate. Response is `{chunkId,indexed:true,sessionId}`.
- Current Rust uses `ON CONFLICT (id) DO NOTHING`; changing collision semantics is outside this port.

## Existing proof and the false-green gap

- `tests/api-parity/audio-index-parity.test.mjs` covers valid write, forged/wrong-session ticket,
  body tenant spoof, retry, invalid span, and finding-audio reachability.
- Its Serena-mapped `before()` starts the shell without porting this route; `impls()` labels the shell
  and Rust separately, but the shell necessarily proxies Rust. The file documents this gap honestly.
- W2.5 must explicitly port the route in that harness and assert local registration, then keep the
  Rust column as oracle. Add expired-ticket and current learner/retention disagreement cases for Node.
- `tests/e2e/teacher-audio-index.test.mjs` is the storage → gateway → index → playback/repair chain;
  cross-language ticket vectors pin the wire format independently.

## Integration points and risks

- Add a claims-returning validator without weakening the existing boolean verifier or ticket vectors;
  parse expiry as unsigned integer data and compare before DB access.
- Within `withTenant(claims.tenantId)`, join session and consent and require current learner and
  retention to match the signed claims; this closes stale/mismatched ownership without body authority.
- Register the route in both literal allowlist and route table; update exact 37-count ownership guards
  to 38 and keep canonical through-Node route derivation mechanical.
- Preserve generic 401 ordering before body-shape disclosure, RLS isolation, raw-ticket secrecy,
  canonical response bytes, and repairability when a ticket expires after audio storage.

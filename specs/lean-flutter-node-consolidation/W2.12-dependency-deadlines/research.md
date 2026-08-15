# W2.12 research — one deadline and cancellation boundary

## Scope

W2.12 implements BE-4 for the current Node HTTP/API, ML, storage/privacy, worker, and Postgres
paths. It does not add a queue/outbox (W2.15), graceful process drain (W2.13), or fold the ML
service into the final backend package (W2.17).

## Measured current state

- `server/src/lib/upstream.mjs::postJson` already applies `AbortSignal.timeout`, but its
  `createDeadline` only reports remaining milliseconds and the deadline is created inside the
  finalizer *after* the first database transaction. It is not a whole-request budget.
- `server/src/lib/proxy.mjs::proxy` has no abort signal. An unavailable compatibility Rust API can
  occupy an admitted request forever, including while reading a partial response body.
- `privacy.mjs::eraseMlAudio` and `review.mjs::getFindingAudio` use raw `fetch` without a timeout.
  The review path deliberately writes an attempt audit before reading storage. Its current
  `outcome: available` means object eligibility, not successful transfer; that needs an explicit
  attempted/served distinction so a timeout never claims playback completed.
- `services/ml-inference/server.mjs` makes three unbounded ASR calls: transcription, forced
  alignment, and acoustic observation. Multi-window transcription starts a fresh wait for every
  window, so elapsed time currently grows with audio length.
- `services/agents/server.mjs` makes five unbounded platform-API calls. `/run` executes its three
  batches sequentially without one shared budget, and its catch path exposes `error.message`.
- `server/src/lib/db.mjs::createDb` installs a fixed 10-second `SET LOCAL statement_timeout` only
  after acquiring a tenant transaction. Tenant-neutral queries, role/readiness checks, and the
  setup statements are not covered by that local setting. A JavaScript `Promise.race` around
  `sql.begin` would be incorrect: it can return a timeout while the transaction later commits.
- Postgres.js 3.4.9 exposes query cancellation, but its own documentation states cancellation is
  race-prone and cannot guarantee the server did not finish. PostgreSQL `statement_timeout` is the
  authoritative cancellation point; an error aborts the open transaction and `sql.begin` rolls it
  back.

## Runtime facts and selected design

- The repository requires Node 22. `AbortSignal.timeout()` and `AbortSignal.any()` are supported in
  that runtime. A single monotonic deadline can therefore expose one signal and combine it with a
  caller/disconnect signal without timers per downstream call.
- The shared helper must be dependency-free and below API/ML/worker policy. `upstream.mjs` imports
  `ApiError`, so it is not the reusable layer. The selected owner is
  `server/src/lib/deadline.mjs`; W2.17 can relocate it mechanically when service boundaries fold.
- Every API request receives one deadline in the earliest local hook. Compatibility proxying,
  route-level upstream calls, and tenant database wrappers consume that same object. Callers that
  invoke ML/agent functions directly retain a bounded default for test and library compatibility.
- `fetchWithDeadline` owns both header and body cancellation. It uses the shared signal and never
  logs a URL, body, token, raw audio, or upstream response detail.
- Postgres connections receive a server-side default `statement_timeout`. Tenant transactions
  tighten it with `min(configured statement timeout, request remaining budget)` before application
  work. No client-side race may claim cancellation before the server has cancelled/rolled back.
- Dependency timeout responses are fixed, retryable 502/503 responses. PostgreSQL SQLSTATE `57014`
  maps to a fixed 503 with `Retry-After: 1`; no driver detail is exposed.
- Review-audio audits remain durable even when storage fails, but record `attempted` before the
  read and are updated to `served` only after a complete, valid object response.

## Symbol/caller map

Serena reference search found:

- `createDeadline` → `postJson`, `finalizeSession`.
- `postJson` → `ml-proxy::{proxyMl,proxyAsr}` and `finalizeSession` twice.
- `proxy` → the compatibility branch of every protected route plus the application catch-all.
- `createDb` → `createApplication`; its returned transaction wrappers serve all database routes.
- ML `transcribeAudio` → `predictAlignment`, `transcribeSession`; `forceAlignRecognizedAudio` →
  `transcribeSession`; `observeAcousticWindow` → `runAcousticShadow` → `predictTajweed`; all three
  public inference functions are dispatched by `route` and imported by existing hermetic tests.
- agent batch functions → `runAllAgents` and their individual HTTP routes; `runAllAgents` → `/run`.

The narrowed implementation impact is recorded in the umbrella `impact-map.md` before edits.

## Evidence sources

- Node 22.13.1 global API: `AbortSignal.any` and `AbortSignal.timeout`:
  <https://nodejs.org/download/release/v22.13.1/docs/api/globals.html#static-method-abortsignalanysignals>
  and
  <https://nodejs.org/download/release/v22.13.1/docs/api/globals.html#static-method-abortsignaltimeoutdelay>.
- Postgres.js cancellation and connection options: <https://github.com/porsager/postgres> and the
  installed 3.4.9 package source under `node_modules/.pnpm/postgres@3.4.9_*`.

## Explicit non-changes

- No canonical Quran bytes, normalization, checksums, Arabic regular expressions, model/evaluation
  claims, RLS policy, login posture, or learner feedback gate changes.
- No new broker, cache, retry library, or alternate HTTP client.
- No hand-authored inference/evaluation output.

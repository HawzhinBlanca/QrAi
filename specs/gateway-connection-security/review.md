# Independent review — realtime-gateway hardening + server-side ML proxy pile

**Scope reviewed:** the full uncommitted working-tree pile (gate-green: `bash scripts/verify.sh` = VERIFY
OK) before its first commit — the `gateway-connection-security` feature plus the coupled work it ships
with: the `shared-ticket` HMAC crate, the server-side ML proxy (`ml_proxy.rs`, keeps `ML_API_KEY` off
the browser), the platform-api integration, and the web practice-flow refactor.

**Method:** a different-model (Claude Sonnet 5) adversarial review — reviewers by lens (Rust-security,
Rust-correctness, web, contracts/API-boundary), each finding then independently verified by trying to
*refute* it against the real code. 19 findings verified; the confirmed set is below. The point: the
pile was already gate-green, so this targeted what the gate does **not** catch (authorization, tenant
isolation, fail-open defaults, info leakage).

## Confirmed findings and resolutions (all fixed)

### Blocker
1. **Cross-tenant IDOR in the ML proxy** (`ml_proxy.rs`). Both proxy handlers authenticated the caller
   but discarded the actor (`let _actor = …`) and forwarded the **client-supplied `tenantId`** verbatim
   to ml-inference, which uses it for audit records and storage object keys. A learner in tenant A
   could set `tenantId: "tenant-B"` and read/pollute another tenant's namespace — defeating the tenant
   isolation the rest of this same diff hardens (eval.rs, recitation.rs).
   **Fix:** a shared `proxy_ml` helper now OVERWRITES `body.tenantId` with the actor's server-validated
   tenant; the client value is never trusted.

### Major
2. **Fail-open `smoke-ml-api-key` default** in the Rust binaries (`ml_proxy.rs`, gateway `lib.rs`). The
   compose guard only protects the compose path; any other deploy that forgot `ML_API_KEY` started with
   the public default. **Fix:** `ensure_secure_config` in both `main.rs` now refuses to boot on an
   empty/default `ML_API_KEY` unless `ALLOW_INSECURE_DEFAULTS` is set.
3. **Active-session Redis counter drifts upward forever** (gateway `lib.rs`). The bare INCR/DECR
   `active-session-count` had no TTL and no reconciliation, so any unclean termination or restart
   over-counted permanently. **Fix:** replaced with a **sorted set scored by expiry** — stale sessions
   self-expire and are evicted on the next count (`ZREMRANGEBYSCORE` + `ZCARD`).
4. **Upstream errors leaked verbatim + mislabeled** (`ml_proxy.rs`, `types.rs`). All ML failures were
   `ApiError::Database` (500) with the raw `reqwest` text (internal URLs) in the JSON body. **Fix:** a
   new `ApiError::Upstream` → **502** with a GENERIC message; the detailed error is logged server-side
   only.
5. **CSWSH: a missing `Origin` header passed through** even in production (gateway `lib.rs`), deviating
   from the feature's own plan. **Fix:** strict mode now fails closed on an absent Origin (browsers
   always send it on cross-origin WS upgrades; dev/native clients use `ALLOW_INSECURE_DEFAULTS`). Test
   updated.
6. **Ticket `tenant_id` never checked against the gateway's tenant** (gateway `lib.rs`). With the ticket
   secret shared across services, a ticket validly signed for tenant B was accepted by a tenant-A
   gateway if the session_id matched. **Fix:** `audio_ws` now rejects a ticket whose `tenant_id` ≠
   `GATEWAY_TENANT_ID`.

### Minor
7. **Origin test mutated process-wide env without serialization** (gateway `lib.rs`) — a flakiness
   landmine for future tests. **Fix:** an `ORIGIN_ENV_LOCK` mutex the test now takes.
8. **ML proxy routes missing from `PUBLIC_API_ROUTES`** (`contracts`) — the "lock the API surface" test
   was silently out of sync. **Fix:** both routes added to the contract and the test.
9. **`actorHeaders` sends Authorization XOR tenant/user/role headers** (web). Acknowledged — a no-op
   today (Bearer is authoritative in `actor_from_headers`, and no consumer reads the `x-*` headers when
   a token is present); left as-is intentionally rather than re-introduce client-supplied identity
   headers.

## Post-fix state
`bash scripts/verify.sh` = **VERIFY OK** (guard + Rust fmt/clippy + TS typecheck + all TS/Rust tests +
build + web-bundle secret scan). The one remaining behavior the unit tests cannot exercise (the
`audio_ws` handler body, because Axum's `WebSocketUpgrade` extractor 426s first in `oneshot`) is
covered by the live gateway smoke suite.

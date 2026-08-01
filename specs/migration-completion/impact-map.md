# Impact map — migration completion

Blast radius, EARS acceptance criteria, and the test that proves each one. Every criterion maps to
at least one automated test (`AGENTS.md` §Acceptance criteria format).

---

## 1. Symbols and files each wave touches

| wave | edits | callers found by `find_referencing_symbols` / grep |
|---|---|---|
| **N7** | `services/node-api/server.mjs` → `+routes/*.mjs` | `scripts/cutover-readiness.mjs:33` (regex on `PORTABLE`), `tests/node-api/shell.test.mjs` (14), `tests/api-parity/lib/harness.mjs:398` `startShell` |
| **N8** | `+routes/infra.mjs` | `scripts/smoke-api.mjs`, `tests/api-parity/metrics.test.mjs`, `docker-compose.yml` healthchecks, `.github/workflows/ci.yml` readiness waits |
| **N9** | `+routes/quran.mjs` | `apps/web` reader, `packages/contracts/fixtures/canonical-gates.json`, `tests/contract/` |
| **N10** | `routes/progress.mjs` (extends N4) | `apps/web` progress panel, `tests/api-parity/db-endpoints.test.mjs` |
| **N11** | `+routes/{agent,audit,eval}.mjs` | `apps/web` internal console, `tests/api-parity/db-endpoints.test.mjs` |
| **N12** | `+routes/auth.mjs` | **every authenticated route**, `lib/authz.mjs:resolveActor`, `tests/api-parity/auth-disabled.test.mjs` |
| **N13** | `+routes/pilot.mjs` | `apps/web/src/App.tsx` (`pilotBootstrapPending`, `needsInvite`), `tests/api-parity/db-endpoints.test.mjs`, cookie tests |
| **N14** | `+routes/recitation.mjs` | `services/realtime-gateway` (ticket verify), `apps/web` practice flow, `apps/mobile` |
| **N15** | `+routes/review.mjs` | `apps/web` teacher/scholar surfaces, `tests/api-parity/db-endpoints.test.mjs` |
| **N16** | `+routes/ml-proxy.mjs` | `services/{ml,asr}-inference`, `tests/api-parity/ml-proxy.test.mjs`, `scripts/smoke-ml.mjs` |
| **N17** | `+routes/privacy.mjs` | `scripts/smoke-privacy.mjs`, ML blob storage, `tests/api-parity/db-endpoints.test.mjs` |
| **F-A** | `+apps/flutter/**` | none in-repo — new tree; consumes `specs/flutter-client/openapi.yaml` |

**Nothing in `services/platform-api` or `services/realtime-gateway` is edited by any wave.** Rust
stays authoritative and unchanged; that is what makes the A/B a real oracle rather than two ports
agreeing with each other.

---

## 2. EARS acceptance criteria → tests

### Track N — invariants that hold for every wave

| # | criterion | test |
|---|---|---|
| **N-1** | WHEN any ported route is requested with a valid actor, THE node-api SHALL return a status, body bytes, and header set identical to platform-api for the same request. | `tests/node-api/parity-cases.test.mjs` (new, per-route case table) |
| **N-2** | WHEN a ported handler reads or writes any tenant-owned table, THE node-api SHALL do so inside `withTenant`, and SHALL NOT acquire a raw client. | `tests/node-api/db-tenant.test.mjs` + a lint assertion that `routes/*.mjs` never imports `postgres` directly |
| **N-3** | IF a ported handler throws after `set_config('app.tenant_id')`, THEN the connection returned to the pool SHALL NOT carry a tenant setting. | `tests/node-api/db-tenant.test.mjs` (existing stale-tenant cases, extended per wave) |
| **N-4** | WHEN `NODE_API_PORTED` is unset, THE node-api SHALL serve zero routes locally and proxy all 38 verbatim. | `tests/node-api/shell.test.mjs`; `scripts/diff-api-fixtures.mjs` byte-identical |
| **N-5** | WHERE a route key is removed from `NODE_API_PORTED`, THE node-api SHALL immediately resume proxying it with no other change. | `tests/node-api/shell.test.mjs` (revertibility case) |
| **N-6** | WHEN the parity suite runs under `PARITY_MUTATE`, THE suite SHALL fail. | `scripts/verify-parity-teeth.sh` |
| **N-7** | THE node-api SHALL NOT log audio bytes, bearer tokens, cookie values, password hashes, or learner PII at any level. | `tests/node-api/no-secret-logging.test.mjs` (new) |

### Per-wave criteria

| # | criterion | test |
|---|---|---|
| **N7-1** | WHEN `PORTABLE` is exported, `scripts/cutover-readiness.mjs` SHALL report the true portable count, not zero. | `tests/contract/cutover-readiness.test.mjs` (extended) |
| **N8-1** | WHEN `/metrics` is requested without the dev-open flag, THE node-api SHALL return the same status as platform-api. | `tests/api-parity/metrics.test.mjs` against the shell |
| **N9-1** | WHEN `/v1/quran/*` returns canonical text, THE bytes SHALL be identical to platform-api's, and the SHA-256 of the text field SHALL equal the committed anchor. | `packages/contracts/fixtures/canonical-gates.json` + parity case |
| **N9-2** | THE node-api SHALL NOT apply Unicode normalization to any canonical string. | digest assertion in N9-1; NFC scan in `scripts/verify.sh` |
| **N12-1** | WHEN a correct password is presented, THE node-api SHALL accept a hash produced by Rust's `bcrypt` cost 12, and Rust SHALL accept one produced by Node. | `tests/node-api/password-vectors.test.mjs` (new, vectors generated **from Rust**) |
| **N12-2** | WHEN a token is minted by either implementation, THE other SHALL verify it, with identical claims. | `tests/node-api/jwt-vectors.test.mjs` (new) |
| **N13-1** | WHEN a pilot session is bootstrapped, THE `Set-Cookie` SHALL carry `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite` and `Path` identical to platform-api's. | parity case asserting raw `getSetCookie()` |
| **N13-2** | WHEN a pilot session is used, THE node-api SHALL roll `idle_expires_at` inside a tenant transaction and SHALL reject the request if the update affects ≠1 row. | port of the PR #283 F2 tests |
| **N14-1** | IF a request names a non-existent `learnerId` or session, THEN THE node-api SHALL return 404, never 5xx. | `tests/api-parity/hostile-input.test.mjs` against the shell |
| **N14-2** | WHEN a realtime ticket is minted by node-api, THE **unchanged Rust gateway** SHALL accept it. | `tests/gateway/` against a Node-minted ticket |
| **N15-1** | WHEN learner-facing AI feedback is returned, THE payload SHALL carry source, confidence, and approval state, and SHALL be withheld absent teacher/scholar approval. | parity case + `tests/api-parity/db-endpoints.test.mjs` |
| **N16-1** | THE node-api SHALL inject the ML/ASR key server-side and SHALL NOT accept it from a query parameter. | `tests/api-parity/ml-proxy.test.mjs` |
| **N16-2** | WHEN a body exceeds the route's limit, THE node-api SHALL return the same status as platform-api (16 MB on ASR routes, 2 MB elsewhere). | parity case |
| **N17-1** | WHEN a privacy delete completes, THE learner's ML audio blobs SHALL be absent from storage, verified by direct query, not by the response status. | `scripts/smoke-privacy.mjs` + parity case |
| **N17-2** | IF the ML service is unreachable during delete, THEN THE node-api SHALL return the same status as platform-api (not a 502 that reads as "retry me" for an unknown learner). | port of PR #279's case |

### Track F (under option F-A)

| # | criterion | test |
|---|---|---|
| **F-1** | WHEN the Flutter package is analyzed, THE analyzer SHALL report zero errors and zero warnings. | `dart analyze --fatal-infos` in `scripts/verify.sh` |
| **F-2** | WHEN canonical Quran text is rendered, THE displayed string SHALL be byte-identical to the API response. | `flutter test` golden + digest assertion |
| **F-3** | WHERE the locale is `ar` or `ckb`, THE layout SHALL resolve RTL and SHALL NOT mirror Latin-script or numeric content. | widget test with `Directionality` |
| **F-4** | WHEN a bearer token is stored, THE client SHALL use Keychain/Keystore and SHALL NOT write it to shared preferences, logs, or disk. | unit test against a fake secure-storage platform channel |
| **F-5** | UNTIL microphone consent is granted, THE client SHALL NOT open an audio stream. | widget test asserting the recorder is never constructed |
| **F-6** | WHEN the device is offline, THE client SHALL show an offline state and SHALL NOT present stale data as live. | widget test with a failing transport |
| **F-7** | WHEN the API contract changes, THE Dart client SHALL fail its contract test. | Dart contract test vs `openapi.yaml` + a live `platform-api` |
| **F-8** | THE Flutter client SHALL NOT render AI feedback lacking source, confidence, or approval. | widget test with an unapproved finding fixture |
| **F-9 🔓 OPEN** | WHEN built for iOS and run on a physical device and a simulator, THE client SHALL pass the device matrix. | **NOT PRODUCIBLE HERE** — needs Xcode + hardware (`research.md §1`). Row stays open. |

**F-9 stays open under every option.** It is the criterion that cannot be met on this machine, and
recording that is the point.

---

## 3. Rollback per wave

| wave | revert |
|---|---|
| N8–N17 | remove the key from `NODE_API_PORTED` → the strangler proxies to Rust again. **No redeploy.** |
| N7 | `git revert`; refactor-only, no behavior change |
| F-A | `apps/flutter/` is a new tree; deleting it affects nothing else |

---

## 4. What could break and is not covered by the above

- **`agent_runs.finding_id` has no FK at all** (spawned as `task_007f40c9`). N11 ports the route as
  it is; adding the constraint needs a migration and a backfill audit of existing dangling rows —
  its own spec, not this one.
- **The 3 `x-unvalidated` operations** (ML/ASR proxies) have no response contract, so N16's parity
  cases assert byte-identity only — not schema conformance. `response-schemas-validated` stays UNMET
  until those routes get a real contract, which is a product decision.
- **`serde`'s deserializer error text** on a 422 remains a recorded, unfixed divergence
  (`research.md §4`). Any wave with a JSON body inherits it.
- **A dirty working tree** blocks candidate-bound release verification regardless of what any wave
  achieves (`research.md §7`).

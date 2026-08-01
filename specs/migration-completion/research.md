# Research — completing the Flutter client and the Node backend migration

Date: 2026-08-01. Continues `specs/flutter-client`, `specs/node-backend-port`,
`specs/flutter-node-migration`, `specs/cutover`. Everything below is measured on this machine
today, not inherited from those documents.

---

## 1. 🔴 The Flutter toolchain is still absent — re-measured today, not assumed

`specs/flutter-client/research.md §6` recorded this on 2026-07-31. It has not changed:

```
which flutter dart          → not found, not found
ls ~/flutter                → No such file or directory
xcode-select -p             → /Library/Developer/CommandLineTools
xcodebuild -version         → error: requires Xcode, but active directory is a CLT instance
xcrun simctl list devices   → error: unable to find utility "simctl"
```

**No Flutter. No Dart. No Xcode — Command Line Tools only.** `simctl` does not exist, so there are
**zero iOS simulators**, and the iOS Simulator tooling available to this session cannot attach to
anything. No physical devices are connected.

Android is *partially* present, which is a different situation and worth stating precisely:

| tool | state |
|---|---|
| `adb` | ✅ `/opt/homebrew/bin/adb` |
| `~/Library/Android/sdk` | ✅ exists — `platform-tools`, `platforms`, `build-tools`, `emulator`, `licenses` |
| `emulator`, `sdkmanager` | ❌ not on `PATH` (binaries exist under the SDK dir; the wrappers do not) |
| `java` | ⚠️ OpenJDK **25** — newer than any Gradle/AGP release line targets; Flutter pins 17/21 |
| `pod` (CocoaPods) | ✅ present, but useless without Xcode |

### What this means for the requested outcome

The request asks for "physical-device and simulator proof for iOS and Android."

- **iOS simulator proof: impossible here.** It needs Xcode — a ~17 GB App Store install requiring
  an Apple ID and an admin password. I cannot perform it.
- **Physical-device proof, either platform: impossible here.** No devices; iOS additionally needs
  Xcode and a signing identity.
- **Android emulator proof: possibly reachable** — SDK bits are on disk. It needs `cmdline-tools`,
  a JDK 17/21 alongside the existing 25, a system image, and an AVD. Reachable without a password;
  not yet proven.
- **Dart correctness proof: reachable.** The Flutter SDK is a user-space tarball needing no admin
  rights, and `dart analyze` / `flutter test` (unit + widget) run headless with **no** Xcode and
  **no** Android Studio.

So the honest split is: *the code and its headless tests are producible here; the iOS half of the
device matrix is not.* §3 of the plan turns that into a choice rather than a silent gap.

### The failure mode to refuse

Writing several thousand lines of Dart that no compiler has ever parsed, and calling it a client,
would be the exact false green this repo has rejected five times (`OC2` mutation checks, `MIG1`'s
"do not touch a test to make this pass", `CU2`'s "a tick is not a signature"). Unverified Dart is
not a deliverable; it is a liability with a plausible shape.

---

## 2. The Node side, by contrast, is fully actionable — and further along than it looks

`services/node-api` is 717 lines across 4 files, and every hard part is already solved:

| file | lines | what it establishes |
|---|---|---|
| `server.mjs` | 407 | Fastify strangler: anything not ported proxies to Rust **verbatim** |
| `lib/db.mjs` | 77 | `withTenant` — tenant-scoped transactions that cannot leak context |
| `lib/authz.mjs` | 126 | `resolveActor` / `requireAnyRole` / `requireSelfOrAny` |
| `lib/ticket.mjs` | 107 | `rt_v1` HMAC tickets, pinned to Rust by cross-language vectors |

The strangler property is the important one: `app.setNotFoundHandler` proxies everything not
explicitly registered, so **backing a route out is deleting one entry**, not redeploying. Reversible
slices are structurally available, not merely intended.

Proven already: with **zero** routes ported the shell passes the entire parity suite (29/29), and
the fixture differ produces byte-identical output through the shell and direct to Rust.

### The primitive that would have failed open

`lib/db.mjs`'s header documents the finding that justifies the whole N3 task: the obvious
node-postgres port (`try/catch/ROLLBACK/finally release`) returns a connection to the pool **still
inside a transaction with `app.tenant_id` set** if the ROLLBACK itself throws. RLS fails *closed* on
a missing tenant context, but a **stale-but-valid** one fails **OPEN** — the database serves the
wrong tenant's rows and every handler filter downstream agrees. `postgres` (porsager) with
`sql.begin(async sql => …)` removes the handle the caller could leak. This is the single most
important reason a route-by-route port must keep using `withTenant` and never open a client directly.

---

## 3. The surface: 38 operations, 2 portable, 0 enabled

`scripts/cutover-readiness.mjs` today:

```
UNMET        traffic-share              Node serves 0 of 38 routes by default (2 portable)
MET          boundary-oracle-coverage   38 of 38 pairs have a fixture or a parity test
UNMET        response-schemas-validated 35 of 38 validated; 3 x-unvalidated
UNMET        rollback-artifact          no workflow builds or pushes an image
UNMET        adr-0022-accepted          Proposed
UNMET        operational-proof          P5.5 and P5.6 open
NEEDS-HUMAN  security-sign-off          P1.7 and P4.1
```

`boundary-oracle-coverage` reaching **38/38** is what makes a route-by-route port viable now and
not before: every operation already has an executable oracle to port *against*.

The 36 unported operations, classified by what the port actually costs:

| wave | operations | Rust source | why grouped |
|---|---|---|---|
| **W1** infra | `/health`, `/ready`, `/metrics` | `lib.rs` | no auth; `/metrics` has a dev-open gate and Prometheus text format |
| **W2** Quran | 3 × `/v1/quran/*` | `quran.rs` (162) | **canonical text — never normalized**; read-only |
| **W3** auth | `token`, `register`, `login` | `auth.rs` (85), `user.rs` (260) | **bcrypt cost 12**, `jsonwebtoken` HS256 |
| **W4** pilot | `bootstrap`, `logout`, `invitations` | `pilot.rs` (306) | `__Host-` cookie attributes, CSRF, idle/absolute expiry |
| **W5** recitation | 6 operations | `recitation.rs` (805) | largest handler; sessions, alignments, teacher-review request |
| **W6** review gates | 5 operations | `review.rs` (306) | **AI feedback must carry source + confidence + approval** |
| **W7** progress | 2 remaining | `progress.rs` (471) | 1 of 3 already ported (N4) |
| **W8** agent/audit/eval | 4 operations | `agent.rs`+`audit.rs`+`eval.rs` (340) | mostly reads; `agent_runs.finding_id` has no FK |
| **W9** privacy | `export`, `delete` | `privacy.rs` (402) | highest stakes; erasure crosses into ML storage |
| **W10** ML/ASR proxies | 4 operations | `ml_proxy.rs` (243) | server-side key injection; 16 MB body limit; the 3 `x-unvalidated` live here |

Total Rust under port: **3,392 handler lines** (5,568 including `lib.rs`, `auth.rs`, `types.rs`).

---

## 4. Wire compatibility is the expensive part, and it is already mapped

The two ported routes cost far more than their logic, and every finding generalizes:

- **`chrono` `to_rfc3339()` emits `+00:00`, not `Z`**, with 0/3/6/9 fractional digits
  (`SecondsFormat::AutoSi`). `Date#toISOString` always emits 3 and always `Z`. The port formats
  timestamps **in Postgres** and trims to match. Bit me again in PR #278 on CI's nanosecond clock.
- **`serde_json` is built without `preserve_order`** → `json!` serializes keys **alphabetically**.
  Key insertion order in the JS object is therefore part of the wire contract.
- **axum's `Json<T>` rejects a malformed body with 422 before the handler runs**, not 400. Clients
  branch on status, so it is matched — but serde's *message text* (with line/column offsets) is a
  **recorded, unfixed divergence**, not something to reimplement.
- **`expiresAt` is `u64::to_string()`** — a decimal string of unix seconds. Emitting RFC3339 there
  would break every client parsing it as a number.
- **`Set-Cookie` must survive with attributes intact.** The proxy uses `getSetCookie()`; iterating
  headers collapses multiples into one comma-joined value and corrupts any cookie whose `Expires`
  contains a comma.
- **A response that carried no `content-type` must still carry none.** Fastify invents one; the
  differ caught it.

None of this is discoverable by reading the Rust. All of it came from an A/B differ. That is the
method the remaining 36 routes need, applied per route.

---

## 5. Oracles that already exist and can be pointed at the port

| asset | what it gives the port |
|---|---|
| `tests/api-parity/` (11 suites + `lib/harness.mjs`, 462 lines) | `startApi`, **`startShell`**, `withDb`, `queryJson`, `urlForRole`, `startMockUpstream`, `RLS_PROBE_ROLE` |
| `scripts/diff-api-fixtures.mjs` + `capture-api-fixtures.mjs` | byte-level A/B, already used to prove the shell indistinguishable |
| `specs/api-golden-fixtures/fixtures/platform-api.json` | 26 committed real responses |
| `specs/flutter-client/openapi.yaml` | 38 operations, 35 with validated schemas |
| `specs/node-backend-port/fixtures/ticket-vectors.json` | 6 cross-language vectors, asserted in **both** Rust and Node |
| `scripts/verify-parity-teeth.sh` | proves the parity suite fails when it should |
| `tests/node-api/db-tenant.test.mjs` (8) | the fail-open stale-tenant case |

`startShell` already exists in the harness. The per-route A/B is a *case table*, not 36 bespoke
test files.

---

## 6. Cutover machinery: three of the five UNMET checks are not engineering

- `rollback-artifact` + `adr-0022-accepted` are **one owner decision** (local tags vs a registry).
  ADR-0022 is `Proposed`. Until it is Accepted, "rollback" means `git checkout && docker compose
  build` — a rebuild, not a rollback.
- `operational-proof` (`P5.5`, `P5.6` — kill switch, rollback, DR drill) needs a **deployment that
  does not exist**.
- `security-sign-off` is `NEEDS-HUMAN` **by construction**: `summarise()` deliberately exposes no
  `ready`/`go` field, and `tests/contract/cutover-readiness.test.mjs` (14 tests) pins that ticking
  `P1.7` by hand still yields `NEEDS-HUMAN`. **A tick is not a signature.**
- `traffic-share` is 0 **by design** — `NODE_API_PORTED ?? ""` defaults to empty. This is the only
  one of the five that porting routes moves.
- `response-schemas-validated` (35/38) is blocked on the 3 ML/ASR proxies having no contract of
  their own, which is a product decision about those routes' shape.

---

## 7. Working-tree constraint, unchanged

11 files are modified by another session (`README.md`, `apps/web/src/App.smoke.test.tsx`, 7 docs,
`docs/superpowers/plans/…`) plus 2 untracked spec directories. **These are not mine to commit.**
Candidate-bound release verification cannot honestly pass while the tree is dirty — which is a
release blocker for any cutover claim, and is the owner's to resolve.

---

## 8. One strategic note, stated once

Porting 3,392 lines of security-critical Rust into JavaScript creates a **second implementation of
every tenant-isolation, RBAC, privacy and audit control** — and N3 exists precisely because the
first naive attempt at one of those primitives failed *open*. The Rust service is complete, tested,
RLS-hardened and serving. The migration's value has to come from something other than the code
itself (team language, hiring, deployment shape); the code is a downgrade in safety per line.

The direction has been reaffirmed, so the plan proceeds in full. The mitigation is structural, not
optional: **no route is enabled without a passing black-box A/B against Rust**, `withTenant` is the
only database path, and the strangler keeps every step one deletion away from reversal.

---

## 9. Callers that constrain both tracks

- `apps/web` (React) — **production-critical, must not regress.** Consumes the same 38 operations.
- `apps/mobile` (React Native / Expo) — exists; a Flutter client does not replace it without a
  separate decision.
- `services/realtime-gateway` — verifies `rt_v1` tickets. Any Node-minted ticket must satisfy the
  **unchanged** Rust gateway; that was N5's oracle and remains the right one.
- `scripts/smoke-*.mjs` (12 scripts) — runtime proof; they must pass against whatever serves traffic.
- `tests/api-parity/*` — the oracle set; it must run against **both** implementations.

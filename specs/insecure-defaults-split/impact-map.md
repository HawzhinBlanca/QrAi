# Impact map — splitting `ALLOW_INSECURE_DEFAULTS`

Scope as approved (option A). Under **B** only rows marked ⬅ B apply. Under **C**, only §5.

---

## 1. Modified — Rust, and all of it is boot-path

Nothing here is called by application code; these are process-start assertions and one per-request
middleware. That is the whole risk profile: **a mistake is a service that does not start**, not a
subtly wrong response.

### `services/platform-api/src/main.rs`

| line | symbol | callers |
|---|---|---|
| 26 | `ensure_secure_config()` | `main()` only — `main.rs:120` |
| 197 | inline, after `PgPool` connect | `main()` only |

`ensure_secure_config` is a private free function with exactly one caller. `find_referencing_symbols`
is unnecessary and `grep -rn "ensure_secure_config" services/platform-api` confirms two hits (the
definition and the call).

### `services/platform-api/src/lib.rs:86` — `AppConfig::default()` → `metrics_dev_open`

**This one has real callers.** `metrics_dev_open` is read by the `/metrics` handler (`lib.rs:412`)
and overridden by a test-only setter (`lib.rs:95`) that exists to dodge process-env races. The
**field** does not change — only which env var populates it — so every reader is unaffected by
construction.

### `services/realtime-gateway/src/main.rs:9` — `ensure_secure_config()`

Same shape: private, one caller (`main.rs:38`).

### `services/realtime-gateway/src/lib.rs`

| line | what | callers |
|---|---|---|
| 459 | `GatewayServerConfig::default()` → `metrics_dev_open` | field read at `lib.rs:599`; `default()` used across `gateway_router` and ~30 tests |
| 463 | `GatewayServerConfig::default()` → `chaos_drop_after_chunks` | pinned by `lib.rs:1206-1213`, which asserts what `default()` yields when the flag is unset — **that test is the tripwire for this row** |
| 713 | `validate_origin` middleware | layered in `gateway_router_with_rate_limit`; reads env **per request**, not at boot ⬅ B |

`GatewayServerConfig::default()` is constructed by many tests. **The struct shape does not change**,
so those callers are source-compatible; what changes is which env var each field reads, and only two
tests set those vars (`lib.rs:1612`, `lib.rs:1664`) — both already hold `ORIGIN_ENV_LOCK`.

## 2. New — no existing callers

| path | what |
|---|---|
| `services/platform-api/src/insecure.rs` | the resolver + its unit tests |
| `services/realtime-gateway/src/insecure.rs` | same, per-service (two crates, no shared dep worth adding for ~15 lines) |
| `tests/security/legacy-insecure-flag.test.mjs` | the repo gate — no production artifact enables the legacy var |
| `specs/insecure-defaults-split/` | this spec |

**Deliberately duplicated, not shared.** `services/shared-ticket` exists because a *wire format* must
not diverge. A 15-line env resolver is not that; a new shared crate for it would be a dependency edge
bought with nothing. If a third service ever needs it, that is the moment.

## 3. Modified — config and docs

| path | line | change |
|---|---|---|
| `docker-compose.yml` | 64, 107 | pass the five new vars through; keep the legacy passthrough; rewrite the comment at 66-68 |
| `.github/workflows/ci.yml` | 27 | **protected** — needs `.codystem-allow-self-edit`, as PAR5/N1/F4/CU4 did. Legacy `"1"` keeps CI green untouched, so this is optional and will only change if S2/S3 prove otherwise |
| `scripts/gen-production-secrets.sh` | 44 | emit the new names at their secure values |
| `scripts/recreate-staging.sh` | 26 | same |
| `docs/TESTING.md` | 118 | the documented local command |
| `docs/SHIP_READINESS.md` | 107-108 | operator guidance |
| `docs/DECISIONS.md` | — | new ADR (a security-boundary change; AGENTS.md requires one) |
| `scripts/verify.sh` | — | **protected**; adds the new test file to the explicit-path line |

## 4. Read, not modified

- **`tests/api-parity/lib/harness.mjs:66,87`** — sets `ALLOW_INSECURE_DEFAULTS: "1"`. §3.3's
  byte-faithful legacy arm is designed so this **does not change**. If it has to, the design failed.
- **`tests/api-parity/metrics.test.mjs`** — the load-bearing dependency on the `"1"`/`"true"`
  asymmetry (`research.md §5`). **Must pass unchanged.** It is the sharpest single check that
  backwards compatibility actually held.
- **`services/node-api/`** — reads no insecure-defaults flag at all. Unchanged, and this is the
  point of the `boundary.md` correction.

## 5. Corrected — the review package ⬅ ships under A, B **and** C

`specs/cutover/boundary.md §3.4` tells a security reviewer the Node shell reads this variable. It
does not (`research.md §4`). `tests/contract/boundary-references.test.mjs:54` requires the document to
keep **mentioning** `ALLOW_INSECURE_DEFAULTS` — satisfied by describing it as resolved history rather
than as an open finding, so that gate stays green either way.

`specs/api-parity-suite/tasks.md` (Findings §2) and `specs/cutover/tasks.md` (§3) record the same
finding and get the same treatment.

## 6. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **A boot assertion is inverted and a service starts insecure** | **nobody, until it is exploited** | the resolver is unit-tested before any call site moves (S1); every panic already has coverage; `tests/api-parity/harness.test.mjs:73-76` asserts a server with `ALLOW_INSECURE_DEFAULTS=0` **panics** |
| A boot assertion is over-strict and a service will not start | immediately — CI, compose, `verify.sh` | the same coverage, from the other side |
| The `Origin` narrowing is inverted and lets any origin through | nobody | S3's acceptance test asserts a **disallowed** origin is still 403 while a missing one passes |
| Chaos becomes readable in production | an operator, as dropped sockets | `lib.rs:1206-1213` pins `default()` with the flag unset |
| A legacy deploy loses a relaxation | at boot, loudly | byte-faithful legacy arm; `metrics.test.mjs` unchanged |
| The repo gate is mistaken for runtime enforcement | a reviewer, wrongly reassured | its ceiling is stated in `plan.md §3.4` **and** in the test's own comment |

## 7. What has no mitigation

**An operator can still export `ALLOW_INSECURE_DEFAULTS=1` and get every old behaviour.** That is
intentional — removing it is a separate breaking change — and it means this reduces the *pressure* to
reach for the blunt instrument without removing the instrument.

Neither service can detect production (`research.md §6`), so §2.6's "assert it is never set in
production" is **not implemented as written**, and `plan.md §3.4` says so rather than claiming a
guarantee the code cannot make.

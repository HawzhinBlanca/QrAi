# API parity suite — Tasks

Scope approved 2026-07-31: **option B** — the 26 incident-class tests, driver **`pg`** (ADR-0023).
See [`plan.md`](plan.md) §4 for what B excludes and why, and [`research.md`](research.md) for the
measurements every number here rests on.

**Task-ID prefix `PAR` is deliberate.** `scripts/update-ledger.sh` matches `- \[ \] <task> ` across
**every** `specs/*/tasks.md`, not just this one. Checked before choosing:
`grep -h "^- \[.\] " specs/*/tasks.md | awk '{print $1}' | sort -u` yields `F1…F5`, `MIG1…MIG5`,
`P0.1…P7.6`, `T0.1…T8` — bare `P1`–`P6` would sit inside the readiness ledger's own namespace.
`PAR*` collides with nothing.

**Precondition for every DB-gated task:** a Postgres with all `infra/sql/0*.sql` migrations plus
`rls-app-role.sql` applied. The suite is skipped, never faked, when none answers — same rule as
`verify.sh:146-177`.

---

## PAR1 — The harness, built and tested before a single test is ported

`tests/api-parity/lib/harness.mjs` — `startApi`, `request`, `queryJson`, `startMockUpstream`.

Built first and alone for the same reason Phase 5 built the normalizer first: a broken harness
produces a suite whose error is **invisible**, because every test it runs agrees with every other.

Non-negotiables, each of which is a way the harness could lie:

- **Ephemeral ports.** A fixed port makes parallel test files collide intermittently — the worst
  kind of red, because it is blamed on the change under review.
- **Never adopt an already-running server.** If `startApi` fell back to whatever answers on a
  well-known port, the suite would report green about a process nobody chose. Missing binary =
  hard failure.
- **`stop()` must actually reap.** An orphan holds its port and its database connections.
- **`queryJson` is the only place the driver is named** (ADR-0023), so swapping it costs one file.

**Acceptance:** `node --test tests/api-parity/lib/harness.test.mjs` passes, including a test that
starts two servers concurrently and asserts two different ports both answer `/health`, and one that
asserts a missing binary raises rather than skips.

**Test ID:** `t-par1-harness`

- [x] PAR1 — Harness — startApi/request/queryJson/mock upstream, with tests for the harness itself.

---

## PAR2 — Default-config group: the 18 incident-class tests needing no special env

Tenant isolation (6), auth/identity (3 of 4), ownership (2 of 3), privacy/consent (2 of 5),
concurrency (2), scholar/agent gate (3) — the members are listed in `plan.md` §4.

**Corrected while implementing: 18 default / 8 config, not 17/9.** Counting the §4 groups gives
6+3+2+2+2+3 = 18. The total is unchanged at 26.

Every ported test's header comment names its origin as `integration.rs:<line>`, so a reviewer can
diff the assertion against the Rust original instead of trusting the transcription.

**Acceptance:** all 18 pass against a migrated Postgres, and each has an `integration.rs:<line>`
provenance comment.

**Test ID:** `t-par2-default-group`

- [x] PAR2 — Default group — Port the 18 incident-class tests that run under default config.

---

## PAR3 — The four non-default config groups: the remaining 8

`auth-disabled` (1), `ml-proxy` (4, against a programmable mock upstream), `cors` (1), `metrics` (2).
Each is a separate server process because `AppState` reads its env once at startup
(`research.md §3`).

**Acceptance:** all 8 pass; each file starts and stops its own server; the run leaves no orphan —
asserted by checking the port is closed after `stop()`, not by inspection.

**Test ID:** `t-par3-config-groups`

- [x] PAR3 — Config groups — Port the 8 tests that need a non-default server configuration.

---

## PAR4 — Teeth: prove the suite FAILS when the behaviour breaks

`scripts/verify-parity-teeth.sh` starts the service deliberately broken and asserts the **named**
tests go red.

**This is the task the phase exists for.** A ported test that passes proves the assertion was
*transcribed*, not that it is *equivalent*; a transcription that weakens an assertion passes forever
and is invisible in review. Nothing else in this plan can catch that.

| mutation | must break |
|---|---|
| `ALLOW_HEADER_AUTH=1` in the auth-disabled group | `rejects_spoofed_header_identity…` |
| DB connected as the superuser role, not `quran_ai_app` | `rls_backstops_a_query…` (exactly how MIG2a was validated) |
| `CORS_ALLOWED_ORIGINS=*` | `test_platform_api_cors_origin_validation` |
| `METRICS_TOKEN` unset with dev-open on | `metrics_endpoint_is_closed_by_default…` |

**A mutation that changes nothing is itself a failure** — it means that test never had teeth.

Evidence goes to `specs/api-parity-suite/evidence/`. Note `.gitignore:28` excludes `*.log`: Phase 4
landed "T1 PASSED" with nothing behind it because of that rule, so the evidence needs a negated
gitignore rule or a non-`.log` extension. Verify the file is actually tracked before claiming done.

**Acceptance:** `bash scripts/verify-parity-teeth.sh` exits 0 only when every mutation produces its
named failure; the committed evidence file is tracked by git (`git ls-files` shows it).

**Test ID:** `t-par4-teeth`

- [x] PAR4 — Teeth — Prove each ported guard FAILS under a deliberately broken server.

---

## PAR5 — Gate it, DB-gated, never skip-if-missing silently

Add the suite to the **DB-gated block** at `verify.sh:146-177` — *not* the explicit `node --test`
path list at `:121`. That line's entries are hermetic; this suite needs both a live Postgres and a
built binary, so putting it there would fail `verify.sh` on every machine without a database.

Plus a CI step that builds and runs the binary against the existing `postgres:16-alpine` service.

**The gating rule:** no Postgres → SKIP (like the Rust integration step, and FAIL under `--release`).
Missing **binary** or missing **driver** → **FAIL**. MIG5 rejected skip-if-missing in as many words;
a soft skip reports green on a machine that gated nothing.

**Acceptance:** `bash scripts/verify.sh` exits 0 with the suite's pass line in the log; a run with no
Postgres prints SKIP and still exits 0; a run with the binary removed **fails**. All three executed,
not reasoned about.

**Test ID:** `t-par5-gated`

- [x] PAR5 — Gate — Wire the suite into verify.sh's DB-gated block and CI.

---

## PAR6 — Account for all 77, mechanically

`tests/api-parity/coverage.json` classifies every Rust integration test as `ported`,
`deferred-to-phase-7` (the 5 category-D), or `mechanical-remainder`, with a reason each.
`coverage.test.mjs` parses `integration.rs` and fails if any test is unaccounted for.

Same discipline as Phase 5 asserting its 5xx gap *as* a gap: the claim goes stale **loudly** when
someone adds a Rust test, instead of quietly.

**Acceptance:** the test fails when a `#[test]` is added to `integration.rs` without a
`coverage.json` entry — verified by adding one temporarily and watching it go red, then reverting.
Do not leave the temporary test committed.

**Test ID:** `t-par6-coverage`

- [x] PAR6 — Coverage ledger — Account for all 77 Rust tests; fail when one goes unclassified.

---

## Not in this phase

- **The 5 category-D tests** (`sm2_update` ×3, `ReviewStatus` serde, `begin_tenant_tx`) — they call
  Rust library functions directly. There is nothing for a Node test to call until Phase 7 writes it.
  Recorded as `deferred-to-phase-7` in `coverage.json`, not as ported.
- **The 46 mechanical-remainder tests** — mostly status codes, validation, and round-trips whose
  response shape the Phase 5 fixture differ already pins on 21 of 34 routes. Recorded, not dropped.
- **Any Node backend code.** That is Phase 7. Nothing here implements a route.
- **Any change to `integration.rs` or `services/platform-api/src/`.** If a ported test disagrees with
  the Rust service, the finding is recorded — changing the service is a separate, visible decision.

---

## Findings recorded, not fixed

Facts about the system that the work surfaced. Recorded the way Phase 5 recorded 200-not-201 and
403-not-401: changing any of them is a separate, visible decision.

### 1. 🔴 The gate has been silently skipping every database test on this machine

`verify.sh:33-38` sources a git-ignored per-machine `scripts/stack.env`, which did
`export DATABASE_URL=…@127.0.0.1:5433/…` **unconditionally** — *after* `verify.sh:28` had already
honoured the caller's value. So `DATABASE_URL=… bash scripts/verify.sh` ran against 5433 no matter
what was passed, and that stack had not existed since Docker reinitialized its VM during Phase 4.

The DB probe therefore failed every time, and **every database-dependent test SKIPPED — the whole
67-test Rust integration suite included — while the run printed `VERIFY OK`.** Found by running the
gate with a live database and watching it skip anyway.

`scripts/stack.env` matches the `.env*` hard boundary in AGENTS.md, so it was **not edited**. Fixed
by rebuilding the database it points at (port 5433, all migrations + `rls-app-role.sql` + the full
82,456-word corpus — which also closes the "staging stack needs rebuilding" item outstanding since
Phase 4). The gate then ran the block for real: **77/77 Rust integration, 39/39 parity**.

**Still open for the owner:** the precedence itself. An explicit `DATABASE_URL` should beat a
per-machine file, or this recurs the next time that stack moves. The one-line fix is
`if [[ -z "${DATABASE_URL:-}" ]]` around the export — in a protected file, so it needs the owner.

### 2. 🟠 `ALLOW_INSECURE_DEFAULTS` means two different things

`metrics_dev_open` is `ALLOW_INSECURE_DEFAULTS == "1"` (`lib.rs:86`), but main.rs's production boot
checks — strong secrets, and the refusal to run as a superuser DB role — accept `"1" OR "true"`
(`main.rs:26-28`, `:197-199`).

So `ALLOW_INSECURE_DEFAULTS=true` skips the boot checks while leaving `/metrics` closed. It fails in
the SAFE direction, so it is an inconsistency rather than a vulnerability — but an operator setting
`=true` expecting dev mode gets a closed `/metrics` with no signal.

`tests/api-parity/metrics.test.mjs` **relies** on this to run in both environments (CI's DATABASE_URL
is a superuser, so a server with boot checks on would panic there). That reliance is documented in
the file, and if someone makes `metrics_dev_open` accept `"true"`, those tests go RED rather than
quietly becoming vacuous.

### 3. The scope split was 18/8, not 17/9

`plan.md` §5 estimated 17 default-config and 9 config-group tests. Counting the §4 groups gives
6+3+2+2+2+3 = **18 default** and **8 config**. Total unchanged at 26. Corrected in place.

### 4. RLS refused the harness's own seed — as designed

The first run of the ported tenant-isolation tests failed with
`new row violates row-level security policy for table "users"`: `queryJson` had no tenant context,
unlike the Rust test pool's `after_connect` (`integration.rs:12-19`). RLS working, caught by the
tests rather than anticipated. `withDb` now sets the session tenant, and the two tests that are
*about* the context pass `tenant: null` so the default cannot mask what they assert.

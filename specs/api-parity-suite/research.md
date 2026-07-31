# Research — Phase 6: port the platform-api integration suite to `node:test`

Everything below was measured against the working tree at `8979902` (Phase 5 merged). Commands are
included so each number can be re-derived rather than trusted.

---

## 1. The suite is 77 tests, not 79

`plan.md` Part 6 says "the 79-test integration suite". Counted:

```bash
grep -c '#\[tokio::test\]\|#\[test\]' services/platform-api/tests/integration.rs   # 77
grep -c '#\[ignore'                   services/platform-api/tests/integration.rs   # 67
wc -l                                 services/platform-api/tests/integration.rs   # 3989
```

| | count |
|---|---|
| test functions | **77** |
| of those, `#[ignore = "requires live Postgres"]` | **67** |
| run with no database | 10 |
| helper functions (not tests) | 13 |
| lines | 3,989 |
| `sqlx::query` call sites | 66 |

77 matches MIG1's measured "76/76 passed" plus the one test MIG2a added afterwards
(`rls_backstops_a_query_that_forgets_its_tenant_context`). The "79" in the migration plan was never
counted; it is corrected in this spec rather than carried forward.

## 2. The tests are IN-PROCESS, not over HTTP

`integration.rs:60-65` — every request goes through `tower::ServiceExt::oneshot` against an
`axum::Router` built inside the test process:

```rust
router.clone().oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap()
```

There is no socket, no server process, no serialization boundary. This is the single fact that
determines the shape of the port: **a `node:test` suite cannot call an in-process Rust router.** It
can only talk to a *running* service over HTTP, or to Postgres directly.

## 3. What each test structurally needs — classified, not estimated

Classifier: `scratchpad/classify.mjs` (parses each `#[test]` body, matches on the AppState builders
enumerated by `grep -o '\.with_[a-z_]*(' integration.rs`, so a builder added later shows up as
unclassified rather than being silently miscounted).

| cat | needs | count | portable to a black-box `node:test` suite? |
|---|---|---|---|
| **A** | HTTP only, default server config | **32** | yes, directly |
| **B** | HTTP + direct SQL assertions | **23** | yes, with a Postgres client |
| **C** | a server started with **non-default env** | **17** | yes, but only with a server-lifecycle harness |
| **D** | direct calls into the Rust library | **5** | **no — there is nothing to call** |

**Category D in full** — these are unit tests of Rust internals, not API tests:

| test | calls |
|---|---|
| `sm2_spaced_repetition_updates_correctly` | `handlers::progress::sm2_update` |
| `sm2_quality_three_is_a_pass_not_a_reset` | `handlers::progress::sm2_update` |
| `sm2_interval_never_exceeds_the_ten_year_cap` | `handlers::progress::sm2_update` |
| `review_status_serializes_teacher_review_required` | `types::ReviewStatus` serde |
| `begin_tenant_tx_activates_rls_context` | `begin_tenant_tx` |

They become portable the moment a Node implementation of those functions exists — i.e. they belong
to **Phase 7**, not Phase 6. Listing them as "ported" in Phase 6 would be fiction.

**Category C in full**, with the configuration each one needs:

| config | tests | how it is set |
|---|---|---|
| `ALLOW_HEADER_AUTH=0` | 1 | `AppState::with_header_auth(pool, secret, false)` |
| `MAINTENANCE_MODE=1` | 1 | `.with_maintenance_mode(true)` |
| `METRICS_TOKEN` / dev-open / closed | 3 | `.with_metrics_access(..)` |
| `CORS_ALLOWED_ORIGINS` | 1 | `std::env::set_var` at `integration.rs:3291` |
| `ML_INFERENCE_URL` → mock | 7 | `.with_ml_inference_url(mock)` |
| `ASR_INFERENCE_URL` → mock | 3 | `.with_asr_inference_url(mock)` |
| `.with_timezone` | 1 | builder |

**All of these are env-backed at startup** (`lib.rs:78,80` use `env_or("ML_INFERENCE_URL", …)` /
`env_or("ASR_INFERENCE_URL", …)`; the full env surface is 17 variables). So each is reachable
black-box — but only by **starting a separate server process per configuration**, because the values
are read once when `AppState` is constructed. That is the one genuinely new piece of machinery this
phase needs.

## 4. A Node HTTP harness already exists here — 3,221 lines of it

```bash
wc -l scripts/smoke-*.mjs   # 3221 total
```

`scripts/smoke-api.mjs:11-30` already does exactly the request shape these tests need — dev-header
identity (`x-tenant-id` / `x-user-id` / `x-user-role`), JSON parse, status check — against
`PLATFORM_API_SMOKE_URL`. `smoke-privacy.mjs`, `smoke-e2e.mjs`, and `smoke-sql.mjs` extend it.

**But they are not tests.** They are `process.exit(1)` scripts: no test names, no per-case isolation,
and the first failure aborts the run so everything after it is unreported. The request helper is
reusable; the harness around it is not.

## 5. `node:test` is already the convention, and already gated

Eight `node:test` files exist, run by **explicit path** at `scripts/verify.sh:121`:

```
run "test: node services" "node --test scripts/fixture-normalize.test.mjs … scripts/smoke-database.test.mjs"
```

A new suite is gated by appending to that line. The comment there records why a directory glob was
rejected (it picks up non-test `.mjs` files) — the same reasoning applies to anything added.

## 6. Node cannot currently reach Postgres without an external binary

```bash
grep -rn '"pg"' --include=package.json .    # no matches
```

There is **no Postgres driver in the repo**. Node reaches the database by shelling out to `psql`
(`scripts/smoke-sql.mjs:162`, with a `PSQL` path override at `:414`).

`psql` is **not on PATH on this machine** (`command -v psql` → empty; the Phase 4/5 drills used
`docker exec … psql`). CI does have it, via the `postgres:16-alpine` service and an explicit ubuntu
path (`.github/workflows/ci.yml:88-97`).

**Corrected during implementation — the claim above was only half right.** `verify.sh:27` prepends a
hardcoded `/opt/homebrew/opt/postgresql@16/bin` to PATH, so anything *verify.sh* runs does find
`psql` here. What does not get that PATH is a developer running `node --test tests/api-parity/…`
directly — and a hardcoded macOS Homebrew path is not a guarantee anywhere else.

The conclusion stands: a `psql`-based harness would **silently skip** wherever the binary is absent.
That is the skip-if-missing anti-pattern MIG5 explicitly forbade, and it is why the driver choice is
`plan.md §7` rather than an assumption.

## 6a. That hazard was not hypothetical — it was live in this repo

Found while wiring PAR5, by running the gate with a database up and watching it skip anyway.

`verify.sh:33-38` sources a git-ignored per-machine `scripts/stack.env`, which did
`export DATABASE_URL=…@127.0.0.1:5433/…` **unconditionally** — *after* `verify.sh:28` had already
honoured the caller's value. So `DATABASE_URL=… bash scripts/verify.sh` silently ran against 5433 no
matter what was passed.

That stack had been gone since Docker reinitialized its VM during Phase 4. The DB probe therefore
failed every time, and **every database-dependent test silently SKIPPED — the whole 67-test Rust
integration suite included — while the run still printed `VERIFY OK`.**

`scripts/stack.env` matches the `.env*` hard boundary in AGENTS.md, so it was **not edited**. Fixed
by rebuilding the database it points at: port 5433, all migrations + `rls-app-role.sql` + the full
82,456-word corpus. The gate then ran the block for real — **77/77 Rust integration, 39/39 parity**.

This is the strongest available argument for ADR-0023 choosing `pg` over a `psql` subprocess: a gate
that skips silently reports green having verified nothing, and this repo was doing exactly that.

## 7. CI does provision a real Postgres

`.github/workflows/ci.yml:10-12,26,88,91` — `postgres:16-alpine` as a service, all
`infra/sql/*.sql` migrations applied, plus `rls-app-role.sql` with `app_password="ci-dummy-password"`.

So Phase 6's stated gate — "suite runs against real Postgres" — **is achievable in CI**, not just
locally. What CI does *not* currently do is start the platform-api binary; `cargo test` builds it but
nothing runs it as a server. Spawning it is new CI work, but small.

## 8. What Phase 5 already covers, and what it cannot

`specs/api-golden-fixtures/fixtures/platform-api.json`: 26 steps over **21 distinct route+method
pairs**, out of 34 routes total.

The fixture differ asserts **response shape** — status, contractual headers, normalized body. It
cannot assert anything about database state. Concretely, it cannot express:

- `privacy_delete_preserves_other_learners_teacher_reviews` — needs a row count for a *different*
  learner after the delete.
- `teacher_review_author_is_actor_and_realignment_cascades` — needs to check the cascade landed.
- `concurrent_progress_updates_for_the_same_ayah_do_not_lose_repetitions` — needs concurrency plus a
  post-hoc row read.
- `rls_backstops_a_query_that_forgets_its_tenant_context` — pure SQL under a restricted role; no HTTP
  request exists that would trigger it.

The two artifacts are complementary: fixtures pin the **wire shape**, this suite pins the
**behaviour and the data**. 23 of the 77 tests (category B) are exactly the ones the fixtures
structurally cannot replace.

## 9. Consequence for sequencing — the finding that shapes the plan

Phase 6's stated gate is "suite runs against real Postgres". Read literally — port the tests so they
exercise a Node backend — the suite has **nothing to run against**, because the Node backend is
Phase 7. The literal deliverable is 77 failing tests.

The only reading under which the gate can go green before Phase 7 is: **port the assertions into a
black-box suite and run it against the running Rust service.** That suite is then the oracle Phase 7
is measured against, and it keeps its value if the migration is cancelled — it guards the Rust
service either way.

Phase 5 already proved the prerequisite: a Node process driving the native platform-api over HTTP on
a dedicated port, against an isolated Postgres, deterministically.

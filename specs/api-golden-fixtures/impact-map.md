# Impact Map — golden API fixtures

Companion to `plan.md` (AGENTS.md step 2). Measured at main `964ffef`.

**No application code is modified by this phase.** It adds capture/diff tooling and a data artifact,
and reads the API's behaviour. That is deliberate: a baseline recorded from a service you changed
while recording it is not a baseline.

---

## 1. New files

| Path | Task | Notes |
|---|---|---|
| `scripts/lib/fixture-normalize.mjs` | F1 | Pure; no I/O, no network. Tested standalone |
| `scripts/capture-api-fixtures.mjs` | F2 | Requires an explicit target URL, **no default** |
| `scripts/diff-api-fixtures.mjs` | F4 | Replays fixtures against any base URL |
| `specs/api-golden-fixtures/fixtures/*.json` | F2/F3 | The artifact. Canonical JSON + digest |
| `scripts/*.test.mjs` for F1/F4 | F1, F4 | Wired into `verify.sh`'s node-services line |

---

## 2. Modified files

### `scripts/verify.sh` — F5 only

Two additions: the F1/F4 unit tests on the existing `test: node services` line (always run, no DB),
and a DB-gated F4 replay in the same block as the platform-api integration tests.

Guarded file — needs the `.codystem-allow-self-edit` sentinel at the CODYSTEM root.

**Failure mode to avoid:** adding the DB-gated replay as a *soft skip* that silently passes when the
API is unreachable. The existing DB-gated block already models the correct shape — skip **loudly**,
never fake. This is the same false-green trap that MIG5 rejected.

### `scripts/smoke-api.mjs` — read, ideally not modified

Its request construction and auth-header handling are reused (research §4). If reuse requires
extracting a helper, that extraction is a **refactor with its own risk**: `smoke-api.mjs` is invoked
by `smoke-all.mjs` and the release-evidence flow. Prefer importing from it over restructuring it; if
restructuring is unavoidable, `pnpm smoke:all` must pass unchanged.

---

## 3. Symbols read but never modified

These define the contract being recorded. **If any changes, the fixtures are stale and F5 will fail
— which is the intended behaviour, not a bug:**

| Symbol / file | Why it matters |
|---|---|
| `platform_router` / `platform_router_with_rate_limit` (`lib.rs:123-353`) | The route table and layer order |
| `ApiError` + its `IntoResponse` (`types.rs:334`, `:375`) | Status codes **and** wire message strings |
| `resolve_actor` (`auth.rs`) | Three auth modes, resolved in a fixed order |
| `metrics_access_allowed` (`lib.rs:432`) | The deliberate 404-not-401 |
| `maintenance_guard` (`lib.rs:344`) | 503 with health/ready/metrics exempt |
| `issue_token` (`handlers/auth.rs`) | The **only** snake_case response body |

---

## 4. Data-safety review

This phase reads and records API responses, so the risk is **committing sensitive data to git**, not
destroying it.

| Hazard | Control |
|---|---|
| `/v1/privacy/export` returns learner data by construction | Seeded synthetic learners only; F3 asserts fixture content contains only known synthetic ids |
| JWTs and pilot CSRF tokens in captured bodies | F1 replaces with `<JWT>` / `<CSRF>`; a token-shaped string that fails the pattern **raises** rather than being committed verbatim |
| `set-cookie` for `__Host-qrai-pilot` | Record the cookie's **attributes** (`Secure`, `HttpOnly`, `SameSite`, `Path`) — those are the security contract — never the value |
| Capture pointed at a real environment by accident | Explicit target URL, no default (same rule as `restore-db.sh`) |

The third row is the subtle one: the cookie *attributes* are exactly what a Node port is likely to
get wrong, so they must be captured — while the value must never be.

---

## 5. Tests per task

| Task | New tests | Must stay green |
|---|---|---|
| F1 | `t-f1-normalize` — placeholder substitution, raise-on-unexpected, snake_case survives | — |
| F2 | `t-f2-capture` — **two runs byte-identical** | `pnpm smoke:all` if `smoke-api.mjs` is touched |
| F3 | coverage assertion: every `ApiError` variant appears | — |
| F4 | `t-f4-differ` — passes against source, **FAILS on altered fixtures** | — |
| F5 | — | Full `verify.sh`; DB-gated block still skips cleanly with no DB |

---

## 6. What these tests would not catch

- **A behaviour that is wrong in the Rust service today.** Fixtures record reality; a bug faithfully
  captured becomes a "requirement" the port must reproduce. Anything that looks wrong during capture
  should be raised as a finding, not silently enshrined — the snake_case body is the known example,
  and the plan deliberately preserves it rather than quietly fixing it mid-migration.
- **Concurrency and ordering effects.** A scripted single-threaded scenario says nothing about
  behaviour under parallel requests.
- **Anything the scenario does not exercise.** Coverage is bounded by the script, so F3's
  every-`ApiError`-variant assertion is the floor, not proof of completeness. Routes reached only by
  unusual states will be missed, and that gap should be stated in the fixture README rather than
  implied away.

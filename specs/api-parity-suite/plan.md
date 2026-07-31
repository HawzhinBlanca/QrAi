# Plan — Phase 6: a cross-language API parity suite

**Status: awaiting approval. Nothing below has been implemented.**

Approved-by: _(unsigned — no work starts until a human signs this line)_

Source: `specs/flutter-node-migration/plan.md` Part 6, phase 6 — *"Port the 79-test integration suite
to `node:test`. Gate: suite runs against real Postgres."*
Evidence for every claim: [`research.md`](research.md).

---

## 1. The finding that changes the shape of this phase

The 77 tests (not 79 — counted, `research.md §1`) run **in-process**: they build an `axum::Router` and
call `.oneshot()` on it. There is no socket. A `node:test` file cannot call an in-process Rust router.

So a literal port — rewrite the tests so they exercise a Node backend — has **nothing to run
against**, because the Node backend is Phase 7. The literal deliverable of Phase 6 is 77 failing
tests, and the stated gate ("suite runs against real Postgres") cannot go green.

**The suite must be black-box, and it must run against the Rust service.** That is the only reading
where the gate is real, and it has a second property worth more than the first:

> If the Flutter/Node migration is narrowed, deferred, or cancelled, this suite still guards the
> service that is actually shipping. It is not migration-only work.

Phase 5 already proved the mechanics — a Node process driving the native platform-api over HTTP on a
dedicated port against an isolated Postgres, deterministically, twice byte-identically.

## 2. What "absolute number 1" means for *this* artifact

Not "77 rows of green". A ported test that passes proves the assertion was **transcribed**, not that
it is **equivalent**. A transcription that quietly weakens an assertion — `assert.ok(res.status >=
400)` where the original demanded exactly 403 — passes forever and protects nothing. That is the same
class of failure as a normalizer whose every output agrees with every other output (Phase 5, F1).

So the standard here is: **every ported test must be shown to fail when the behaviour it guards is
broken.** Not argued — executed, and the output committed. Precedent: Phase 4 truncated a table to
prove the restore verification had teeth; Phase 5's differ tests are mostly must-fail cases.

## 3. Approach

**Black-box over HTTP + direct SQL.** Three seams, and only three:

| seam | why it is a seam |
|---|---|
| `startApi({ env })` | starts the platform-api binary on an ephemeral port, waits for `/health`, returns `{ baseUrl, stop() }`. Config is read once at startup, so **each non-default config needs its own process** (`research.md §3`). |
| `request(baseUrl, path, opts)` | the dev-header identity shape already written in `scripts/smoke-api.mjs:11-30`. Reused, not reinvented. |
| `queryJson(sql)` | the **only** place Node touches Postgres. One function, so the driver decision (§7) costs one file to reverse. |

**One file per configuration group**, because a group is a server process:

```
tests/api-parity/lib/harness.mjs      startApi / request / queryJson / mock upstream
tests/api-parity/default.test.mjs     the bulk — default config
tests/api-parity/auth-disabled.test.mjs   ALLOW_HEADER_AUTH=0
tests/api-parity/ml-proxy.test.mjs        ML_INFERENCE_URL / ASR_INFERENCE_URL -> mock
tests/api-parity/cors.test.mjs            CORS_ALLOWED_ORIGINS
tests/api-parity/metrics.test.mjs         METRICS_TOKEN / dev-open / closed
```

## 4. Scope — a decision for the approver, not for me

Porting all 77 is possible but two of the four categories resist it (`research.md §3`):

- **5 tests cannot be ported at all right now** (category D). They call `sm2_update`,
  `ReviewStatus` serde, and `begin_tenant_tx` directly. There is no Node equivalent to call until
  Phase 7 writes one. They are Phase 7 work; claiming them here would be fiction.
- **17 tests need a server per configuration** (category C) — feasible, but it is the machinery, not
  the assertions, that costs the time.

| option | scope | cost | what you get |
|---|---|---|---|
| **A — literal** | all 77 (minus the 5 impossible) | **4–5 weeks** | Full parity. Also: every behaviour change now needs editing tests in two languages for the 24–42 weeks Phases 7–9 take, on a product with zero users. |
| **B — incident-class first** ⭐ | **26 of 77**, all 5 config groups | **2–2.5 weeks** | Every test whose failure would be a security or data-integrity incident. The harness is complete, so the remaining 46 become mechanical. |
| **C — defer** | nothing | 0 | Phase 7 gets only the 26 fixture steps over 21/34 routes, shape-level only — no database assertions at all. |

**Recommendation: B.** The reason is not effort, it is *duplication value*. The 46 tests left out are
mostly status codes, input validation, and round-trips — and Phase 5's fixture differ already pins
response shape on 21 of 34 routes. Porting those buys shape coverage a second time. The 26 selected
are the ones the fixtures **structurally cannot** express, because they assert on database state
(`research.md §8`).

If the answer is A, say so and the task list below extends rather than changes — the harness is
identical either way.

### The 26 (measured category in brackets)

| group | tests |
|---|---|
| **Tenant isolation** (6) | `adversarial_sql_isolation_prevents_cross_tenant_access` [B], `rls_backstops_a_query_that_forgets_its_tenant_context` [B], `adversarial_api_isolation_prevents_cross_tenant_{read,write,delete}` [A], `teacher_of_another_tenant_cannot_read_this_tenants_sessions_findings_or_alignments` [B] |
| **Auth / identity** (4) | `rejects_spoofed_header_identity_when_header_auth_disabled` [C], `register_cannot_create_elevated_user_in_another_tenant` [B], `pilot_cookie_mutation_requires_origin_and_csrf` [A], `learner_progress_learner_id_is_authorized` [A] |
| **Ownership gates** (3) | `request_teacher_review_flips_own_draft_session_and_is_owner_gated` [B], `ml_proxy_rejects_analysis_against_another_learners_session` [C], `ml_proxy_refuses_analysis_for_a_session_that_does_not_exist` [A] |
| **Privacy / consent** (5) | `privacy_delete_preserves_other_learners_teacher_reviews` [C], `privacy_delete_erases_learner_agent_runs` [C], `privacy_export_reports_included_records_but_deletes_nothing` [B], `ml_proxy_overwrites_client_consent_with_the_stored_session_consent` [C], `create_session_external_processing_requires_both_asr_consent_and_guardian_approval` [B] |
| **Concurrency** (2) | `concurrent_registration_with_same_email_is_race_safe` [A], `concurrent_progress_updates_for_the_same_ayah_do_not_lose_repetitions` [B] |
| **Scholar / agent gate** (3) | `create_agent_run_rejects_approved_without_sources` [A], `create_agent_run_rejects_approved_with_an_unreviewed_review_status` [A], `create_scholar_approval_rejects_high_risk_approval` [A] |
| **Boundary config** (3) | `test_platform_api_cors_origin_validation` [C], `metrics_endpoint_is_closed_by_default_without_dev_flag_or_token` [C], `metrics_endpoint_requires_a_token_when_one_is_configured` [C] |

CORS is in deliberately: `specs/flutter-node-migration/plan.md §2.4` names it as one of the four
blockers where "the obvious port is wrong in the CSRF-enabling direction". A suite that omits it
would be green through exactly the regression the migration plan predicts.

## 5. Tasks

### P1 — The harness, built and tested before any test is ported

`tests/api-parity/lib/harness.mjs`: `startApi`, `request`, `queryJson`, `startMockUpstream`.

- `startApi` binds an **ephemeral port** (never a fixed one — parallel test files must not collide),
  polls `/health` with a timeout, and **fails loudly** if the binary is missing. It must never fall
  back to an already-running server: a suite that silently tested someone's dev instance would report
  green about the wrong process.
- `queryJson` is the sole DB seam (§7).
- Tests for the harness itself: port-collision safety, `stop()` actually reaps the child, and a
  missing binary raises rather than skips.

**Acceptance:** `node --test tests/api-parity/lib/harness.test.mjs` passes; starting two servers
concurrently yields two different ports and both answer `/health`.

### P2 — Default-config group: the 17 incident-class tests that need no special env

**Acceptance:** all 17 pass against a freshly migrated, seeded Postgres. Each ported test's header
comment names the Rust test it came from (`integration.rs:<line>`), so drift is reviewable.

### P3 — The four non-default config groups: the remaining 9

`auth-disabled` (1), `ml-proxy` (5, against a programmable mock upstream), `cors` (1), `metrics` (2).

**Acceptance:** all 9 pass; each file starts and stops its own server; the full suite leaves no
orphaned processes (checked by asserting the port is closed after the run).

### P4 — Teeth: prove the suite FAILS when the behaviour breaks

`scripts/verify-parity-teeth.sh` runs the suite against deliberately weakened server configurations
and asserts the *expected named tests* go red — a suite that stays green under a broken server is
worthless, and that is not detectable by reading it.

Mutations, each targeting a different guard:

| mutation | must break |
|---|---|
| `ALLOW_HEADER_AUTH=1` in the auth-disabled group | `rejects_spoofed_header_identity…` |
| DB connected as the superuser role instead of `quran_ai_app` | `rls_backstops_a_query…` (this is exactly how MIG2a was validated) |
| `CORS_ALLOWED_ORIGINS=*` | `test_platform_api_cors_origin_validation` |
| `METRICS_TOKEN` unset with dev-open on | `metrics_endpoint_is_closed_by_default…` |

**Acceptance:** the script exits 0 only when **every** mutation produces the **named** failure. A
mutation that changes nothing is itself a failure — it means that test never had teeth. Output
committed to `specs/api-parity-suite/evidence/`, and note `.gitignore:28` excludes `*.log` (Phase 4
landed "T1 PASSED" with nothing behind it because of that rule — a negated rule is required, or use a
non-`.log` extension).

### P5 — Gate it

Append the suite to `scripts/verify.sh:121`'s explicit path list, and add a CI step that builds and
runs the binary against the existing `postgres:16-alpine` service.

**Gating rule, non-negotiable:** DB-gated exactly like the existing Rust integration step
(`verify.sh:146-177`) — **skipped when no Postgres answers, never faked**. But a *missing binary* or
*missing driver* must **fail**, not skip. MIG5 rejected skip-if-missing for precisely this reason: a
soft skip reports green on a machine that gated nothing.

**Acceptance:** `bash scripts/verify.sh` exits 0 with the suite's `N/N` line in the log; the same run
on a machine with no Postgres prints SKIP for it and still exits 0; a run with the binary deleted
**fails**.

### P6 — Record what was NOT ported, mechanically

A committed `coverage.json` + a test asserting it matches reality: every one of the 77 Rust tests is
either `ported`, `deferred-to-phase-7` (the 5 category-D), or `mechanical-remainder` — with a reason
per entry, and **no test unaccounted for**.

This is the Phase 5 pattern where the 5xx gap was asserted *as* a gap: the claim goes stale loudly
if someone adds a Rust test and forgets this suite, rather than quietly.

**Acceptance:** the test fails if a `#[test]` is added to `integration.rs` without a `coverage.json`
entry. Verified by adding one temporarily and watching it go red.

## 6. Non-goals

- **No Node backend.** Nothing in this phase implements a route. That is Phase 7.
- **No changes to `integration.rs`.** The Rust suite stays as-is and keeps running. Deleting it in
  favour of the port would trade a suite that runs in CI today for one that has never run.
- **No re-porting of what the fixture differ already covers** (under recommendation B) — named in
  P6's `mechanical-remainder`, not silently dropped.
- **No performance/load assertions.** Different phase, different apparatus.

## 7. Open decision — the Postgres driver (needs ADR-0023)

There is no Postgres driver in this repo; Node reaches the DB by shelling out to `psql`
(`smoke-sql.mjs:162`). **`psql` is not on PATH on this machine** — verified, `research.md §6`. CI has
it; a developer may not.

| | `psql` subprocess | `pg` (npm), devDependency |
|---|---|---|
| new dependency | none | one, dev-only |
| works without external binary | **no** | yes |
| behaviour when absent | suite skips → **the false-green MIG5 forbade** | n/a |
| transactions / `SET LOCAL ROLE` | possible (one multi-statement script per call) | native |
| Phase 7 needs a driver anyway | doesn't help | this is the choice, made cheaply |

**Recommendation: `pg` as a devDependency**, with ADR-0023 recording it, because the psql path's
failure mode is a silent skip and this repo has already been burned by one. Either way `queryJson()`
is the single seam, so reversing costs one file.

**This is an approver decision.** If `pg` is rejected, P1 uses `psql` and P5 makes its absence a hard
failure rather than a skip.

## 8. Risks

| risk | mitigation |
|---|---|
| **Transcription that weakens an assertion** — the central risk; invisible in review and in a green run | P4's teeth check. This is why P4 is a task and not a nice-to-have. |
| Black-box loses in-process injection | Accepted and bounded: it costs exactly the 5 category-D tests, enumerated in `research.md §3`, deferred not hidden. |
| Server-lifecycle flake (ports, startup races, zombies) | Ephemeral ports; `/health` polling with a timeout; P3 asserts the port is closed after the run. |
| Dual maintenance for 24–42 weeks | The explicit argument for scope B. Recommendation A is available and costed. |
| CI time grows (build + run the binary) | `cargo test` already builds it; the added cost is process startup, not compilation. |

## 9. What this phase does NOT establish

- **Not** that a Node backend is correct. It establishes the *oracle* that would judge one.
- **Not** full behavioural parity. Under B it covers 26 of 77 tests; under A, 72 of 77.
- **Not** that the Rust service is bug-free. A ported test that passes says the Rust behaviour is
  what the Rust test said it was — the two agree because they describe the same implementation.
- **Not** anything about Flutter, realtime-gateway, or the HMAC ticket contract.

## 10. Question for the approver

Two answers unblock implementation:

1. **Scope: A (all 77), B (26, recommended), or C (defer)?**
2. **Driver: `pg` devDependency (recommended, ADR-0023), or `psql` subprocess?**

Both default to the recommendation if you just say "approved".

# Flutter + Node.js Migration — Tasks

Scope: **Phase 1 + Phase 2 only** (plan.md Part 6), not the full 9-phase migration. This is the
deliberate "best" scope, not the biggest one:

- Phases 1–2 are the only phases that are (a) engineering-only — no owner/scholar/legal/SRE approval
  required, and (b) valuable regardless of whether the Flutter/Node decision proceeds, gets narrowed,
  or is reversed later.
- Phases 3–9 stay unplanned here on purpose. Phase 3 is a schema-breaking data migration (word ids,
  FKs) that needs its own research → plan cycle once Phase 1's discovery is in. Phases 5–9 are gated
  on approvals that don't exist yet (`P0.1` has no assigned owners), so writing granular tasks for
  them now would be planning theater — tasks a human can't actually authorize yet.
- When Phase 1 lands, re-run `plan` for Phase 3 (data migration) as its own spec before touching it.

**Task-ID prefix `MIG` is deliberate.** `scripts/update-ledger.sh` matches `- \[ \] <task> ` across
**every** `specs/*/tasks.md` file, not just this one (verified: existing specs already use bare `P0.1`
style IDs that would collide with the readiness ledger's own `P0.1`). `MIG*` cannot collide with any
existing ID in this repo (checked: `grep -h "^- \[.\] " specs/*/tasks.md`).

**No `spec.md` / EARS criteria for this feature.** The `plan` skill template calls for one; writing
formal EARS acceptance criteria for a discovery task ("find out what breaks") would be fabricated
precision — you cannot predeclare the acceptance criterion for a bug you haven't found yet. Each task
below has a concrete, bash-checkable acceptance test instead. This is a deliberate, noted deviation,
not an oversight.

---

## MIG1 — RLS discovery: run the real suite as the real restricted role

**Not a fix. A measurement.** `infra/provision/app-role.sql` already provisions `quran_ai_app`
(`nosuperuser nobypassrls`) and CI already runs it — but nothing has ever connected AS that role.
`begin_tenant_tx`'s own doc comment admits RLS is a no-op under the superuser dev/CI role.

**Do:**
1. Locally: `MIGRATION_DATABASE_URL="postgresql://hawzhin@localhost:5432/quran_ai" APP_DATABASE_PASSWORD="<strong-local-pw>" node server/scripts/provision-role.mjs`
2. Run: `DATABASE_URL="postgresql://quran_ai_app:<local-pw>@localhost:5432/quran_ai" bash scripts/verify.sh`
   (verify.sh already honors an inherited `DATABASE_URL` — no script change needed for this task.)
3. Capture the **full** log (pass or fail) to `specs/flutter-node-migration/evidence/mig1-rls-discovery.log`, committed verbatim.

**⚠️ Anti-cheat deviation, stated explicitly:** this task's acceptance is **NOT** "verify.sh exits 0."
The audit predicts several failures (the pilot idle-roll is named as a likely one). A green run here
would itself be a surprising finding worth double-checking, not a task to declare done and move past.
**Do not touch any test, handler, or SQL file to make this pass.** Do not use `.only`/skip. This task
is done when the log is captured and committed honestly — red or green, either is a valid result.

**Acceptance:** `specs/flutter-node-migration/evidence/mig1-rls-discovery.log` exists, is non-empty,
and its final section is real `cargo test` / `pnpm test` output (not summarized, not edited).

**Test ID:** `t-mig1-log-exists` (checked by presence + non-triviality of the committed log, not by
verify.sh — see deviation note above).

- [x] MIG1 — RLS discovery — Run the platform-api suite as `quran_ai_app`, commit the raw log.

### MIG1 RESULT: GREEN. The predicted failure did not materialize.

Evidence: `evidence/mig1-rls-discovery.log` (1,114 lines, ends `VERIFY OK` / `VERIFY_EXIT=0`).

Setup: isolated Postgres (`qrai-mig1-pg`, port 5434 — the running `quran-ai-staging` stack was NOT
touched), all 20 migrations + `rls-app-role.sql` applied, full Quran seeded (6,236 ayahs / 114 surahs
/ 82,456 words), then `DATABASE_URL=postgresql://quran_ai_app:...@localhost:5434/quran_ai bash scripts/verify.sh`.

**Role privileges confirmed empirically before the run:**

| role | rolsuper | rolbypassrls | `select count(*) from users` with no tenant set |
|---|---|---|---|
| `hawzhin` (dev + CI default) | t | t | **5** |
| `quran_ai_app` | f | f | **0** |

**Result: 76/76 integration tests passed** under the restricted role (vs 10 passed / 66 ignored
without a live DB). All 6 pilot tests passed, including
`pilot_admin_mints_and_learner_bootstraps_and_cookie_authenticates` — the audit named the pilot
idle-roll as the most likely casualty and it was not.

**Falsification check** (because a green run on a task that predicted red is exactly where a false
positive hides): the same test was re-run against a bogus port 5999 and FAILED after 30s, proving
`DATABASE_URL` is genuinely honored and the pass was not a silent fallback to another database.

### MIG2 RESULT: correcting the premise, and naming the real gap

**Correction — the plan overstated this, and so did I in chat.** `plan.md` §0.3 says *"RLS has never
executed in any test."* **That is false.**
`services/platform-api/tests/integration.rs:3097` — `adversarial_sql_isolation_prevents_cross_tenant_access`
— issues `SET LOCAL ROLE quran_ai_app` **specifically so RLS applies**, then asserts a cross-tenant
SELECT returns 0 rows and a cross-tenant INSERT raises `42501`. Its own comment records that this was
a deliberate fix after a CI flake where the test "failed open." Three tests reference the restricted
role. The audit agent missed them; I relayed the claim as verified without checking. `plan.md` §0.3
is corrected in the same commit as this line.

**What was actually true:** *most* tests run with RLS inert (the default `DATABASE_URL` is a
superuser), so RLS was proven only for the one hand-built adversarial path, never for the application
as a whole.

**What MIG1 newly establishes:** the entire suite passes with the app connecting as `quran_ai_app`
end-to-end. Production can run under the restricted role without breaking — now measured, not assumed.

**The real remaining gap** (neither MIG1 nor the existing tests cover it): every handler currently
sets its tenant context correctly, so nothing ever exercises RLS as a *backstop*. There is no test
proving RLS would catch a handler that **forgets** `begin_tenant_tx`. That is precisely the failure
mode a Node port introduces (a stray `pool.query()` outside the transaction), so it is worth having
before any port — tracked as **MIG2a** below, not silently closed here.

- [x] MIG2a — Backstop test — Prove RLS catches an unscoped query (a handler that forgets `begin_tenant_tx`), not just a hostile one.

---

## MIG2 — Triage MIG1 into named, individually verifiable fix tasks

**Do:** Read the MIG1 log. For each distinct failure (not each failing test — group by root cause),
append a new task below this line, following the `MIG2a`, `MIG2b`, … numbering, each with:
- The exact failing test name(s) as evidence.
- A one-line root-cause hypothesis grounded in the log, not guessed.
- A concrete acceptance test (usually: that named test passes under `quran_ai_app`, and the full
  suite still passes under the normal dev role — a fix must not be tenant-role-specific).

If MIG1 came back fully green, MIG2 is instead: write a short note in this file explaining why the
audit's predicted failure (the pilot idle-roll write, `lib.rs:449-451`'s doc comment) did not
materialize, and what that implies about the comment being stale.

**Acceptance:** this file (`tasks.md`) has been edited to add `MIG2a…` rows with real test names, OR
the green-run explanation above is written. Reviewable by reading the diff — no script proves this
one, a human does.

- [x] MIG2 — Triage — Turn MIG1's findings into named fix tasks (or explain an unexpected green run).

*(MIG2a, MIG2b, … appended here once MIG1 lands. Do not pre-write them — that would be planning
against evidence that doesn't exist yet.)*

---

## MIG3 — Golden-vector corpus for the 10 `packages/contracts` safety functions

**Do:** Extract the existing assertions in `packages/contracts/tests/platform-contracts.test.ts`
(already covers `canShowLearnerFacingAiOutput`'s boundary cases, including the fail-closed
`unrecognizedStatusRun → false` case at the "fails CLOSED" test) into
`packages/contracts/fixtures/canonical-gates.json` — an array of `{fn, input, expected}` triples, one
file per function group. The TS suite is rewritten to **consume** the JSON (loop + assert), not to
duplicate it as hardcoded literals — the corpus, not the test file, becomes the source of truth so a
future Dart/Node port can read the same file.

Cover, at minimum, all cases already in the test file for: `canShowLearnerFacingAiOutput`,
`mustDiscardAudio`, `canUseExternalAsr`, `verifyCanonicalWord`, `hasCanonicalTextChanged`,
`createCanonicalChecksum`, `sha256Hex`, `modelEvalPassesReleaseGate`.

**Acceptance:** `bash scripts/verify.sh` exits 0, and `packages/contracts/tests/platform-contracts.test.ts`
contains a loop reading `fixtures/*.json` (not a hardcoded literal per case) for at least
`canShowLearnerFacingAiOutput`.

**Test ID:** `t-mig3-fixture-consumed`

- [x] MIG3 — Golden-vector fixtures — Extract contract-function test cases into consumable JSON.

---

## MIG4 — NFC-forbidden invariant, pinned by real corpus vectors

**Do:** Using the measured fact that 5,771/6,236 ayahs change under NFC (dominant transform: shadda
canonical reordering `U+0651 U+064E → U+064E U+0651`), pick 3 real ayahs from
`packages/quran-data/src/data/full-quran/` that exhibit this, and commit them as explicit codepoint
arrays (not literal characters — see the `forced_align.py` incident in PR #258 for why literal
combining marks are the wrong medium) in `packages/quran-data/fixtures/nfc-vectors.json`.

Add a test in `packages/quran-data` asserting `text !== text.normalize("NFC")` for each vector — this
is a **regression trap**: it fails the moment anything in the pipeline starts normalizing, which is
exactly the failure mode `server.py:626-632` depends on not happening.

Add one line to `AGENTS.md` under "Hard boundaries": *"Never call `.normalize()` on canonical Quran
text or any string derived from it — the corpus is intentionally NFC-unstable; see
`packages/quran-data/fixtures/nfc-vectors.json`."*

**Acceptance:** `bash scripts/verify.sh` exits 0, `grep -q "normalize" AGENTS.md` finds the new line,
and the new test fails if temporarily edited to assert `.normalize("NFC")` equality (verify this by
hand once, then revert — do not leave the inverted assertion committed).

**Test ID:** `t-mig4-nfc-trap`

- [x] MIG4 — NFC invariant — Commit codepoint vectors + regression trap + AGENTS.md line.

---

## MIG5 — Wire Python eval tests into the gate (the gap PR #256 flagged)

**Do:** `scripts/verify.sh` currently runs no Python tests, so `test_audio_guards.py`,
`test_eval_metrics.py`, and the new `test_forced_align_normalization.py` are all ungated. Add a step
to `scripts/verify.sh` (guarded, matching the file's existing style) that runs the `asr-inference`
plain-interpreter test files (the ones documented as `python test_x.py`, requiring no torch/model) and
add the equivalent `setup-python` step to `.github/workflows/ci.yml`.

**Explicitly do not** make this a soft/skip-if-missing step — that reproduces the false-green problem
the mutation-testing gate exists to prevent. If Python isn't available, the step must fail loudly, not
skip silently.

**Acceptance:** `bash scripts/verify.sh` exits 0 locally AND its log shows the three Python test files
actually ran (grep the log for their `N/N passed` lines). CI workflow diff adds a real `setup-python`
step, not a conditional.

**Test ID:** `t-mig5-python-gated`

- [x] MIG5 — Gate Python tests — Wire the three existing plain-interpreter suites into verify.sh + CI.

### MIG5 STATUS: DONE (#262). Resolved — the blocker below is kept as the record of how.

Merged in #262 after the dependency was cleared. Proven in the gate run:

```
test_eval_metrics.py                 27/27 passed
test_forced_align_normalization.py    6/6 passed
VERIFY OK
```

`test_audio_guards.py` remains excluded and ungated — named in the verify.sh comment, not silently
dropped (system python3 has numpy 2.4.4 but not fastapi, which it imports).

**Clearing the blocker surfaced a bigger problem.** #258 and #256 could not be merged because CI was
**red on every branch, including `main` at e0f37c1** — `pnpm audit` started failing the day
GHSA-r28c-9q8g-f849 published (postcss <=8.5.17 path traversal, reachable transitively via vite).
Nothing in the repo had changed; the same commit passed earlier (d6a8b40 green, e0f37c1 red). Fixed
in **#261** by pinning `postcss >=8.5.18` (resolved 8.5.24) — pinned forward, not suppressed with an
audit-ignore, so the P4.4 supply-chain gate keeps its teeth. Note the override had to go in
`pnpm-workspace.yaml`: pnpm 10+ **silently ignores** `pnpm.overrides` in `package.json` (verified —
the install reported "Already up to date" and kept the vulnerable version, with no warning).

Merge order that unblocked this: **#261 → #258 → #256 → #262**.

---

#### Original BLOCKED record (kept deliberately — this is what "BLOCKED is a success state" looks like)


The change was written and run. `verify.sh` **failed correctly**:

```
==> test: python (asr-inference)
can't open file '.../services/asr-inference/test_eval_metrics.py': [Errno 2] No such file
    ✗ test: python (asr-inference) failed
VERIFY FAILED
```

**Cause:** the two gateable suites live on branches that are not merged yet —
`test_eval_metrics.py` on `feat/eval-metrics-core` (#256), `test_forced_align_normalization.py` on
`fix/arabic-diacritic-regex` (#258). Neither exists on `main`, so a `verify.sh` step referencing them
breaks the gate for everyone until those land.

**Reverted rather than worked around.** The tempting fix — guarding each file with
`[ -f ... ] &&` — is the skip-if-missing anti-pattern this task explicitly forbids: it would report
green on `main` while gating nothing at all.

**Unblock:** merge #258 and #256, then re-apply (the change is small and known-good):

1. `scripts/verify.sh` — after the `test: mobile` line, add a `test: python (asr-inference)` step
   running `python3 test_eval_metrics.py && python3 test_forced_align_normalization.py` from
   `services/asr-inference`, with `command -v python3` asserted (hard fail, never skip).
2. `.github/workflows/ci.yml` — add `actions/setup-python@v5` (3.11) + `pip install "numpy>=2"`
   before the Rust toolchain step.

**Verified while attempting:** system `python3` has numpy 2.4.4 (so both suites run with no venv),
and does **not** have fastapi — which is why `test_audio_guards.py` is excluded: its docstring claims
plain-interpreter but it imports fastapi and shells out to ffmpeg. That one stays ungated until CI
installs the asr-inference requirements. Named here rather than silently dropped.

---

## Next spec (not started here)

Once MIG1–MIG5 are done, run `research` + `plan` again for **Phase 3: canonical corpus rework**
(separating the 4,578 non-recited waqf/sajdah/hizb tokens from real words) as its own
`specs/canonical-corpus-rework/` — it is schema-breaking and touches `word_alignments` /
`tajweed_findings` / `teacher_reviews` foreign keys, and deserves its own impact-map, not a bullet in
this one.

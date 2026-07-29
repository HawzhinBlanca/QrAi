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

**Not a fix. A measurement.** `infra/sql/rls-app-role.sql` already provisions `quran_ai_app`
(`nosuperuser nobypassrls`) and CI already runs it — but nothing has ever connected AS that role.
`begin_tenant_tx`'s own doc comment admits RLS is a no-op under the superuser dev/CI role.

**Do:**
1. Locally: `psql "postgresql://hawzhin@localhost:5432/quran_ai" -v app_password="<local-pw>" -f infra/sql/rls-app-role.sql`
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

- [ ] MIG1 — RLS discovery — Run the platform-api suite as `quran_ai_app`, commit the raw log.

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

- [ ] MIG2 — Triage — Turn MIG1's findings into named fix tasks (or explain an unexpected green run).

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

- [ ] MIG3 — Golden-vector fixtures — Extract contract-function test cases into consumable JSON.

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

- [ ] MIG4 — NFC invariant — Commit codepoint vectors + regression trap + AGENTS.md line.

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

- [ ] MIG5 — Gate Python tests — Wire the three existing plain-interpreter suites into verify.sh + CI.

---

## Next spec (not started here)

Once MIG1–MIG5 are done, run `research` + `plan` again for **Phase 3: canonical corpus rework**
(separating the 4,578 non-recited waqf/sajdah/hizb tokens from real words) as its own
`specs/canonical-corpus-rework/` — it is schema-breaking and touches `word_alignments` /
`tajweed_findings` / `teacher_reviews` foreign keys, and deserves its own impact-map, not a bullet in
this one.

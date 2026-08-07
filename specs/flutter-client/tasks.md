# Flutter client — Tasks

Scope approved 2026-07-31: **option A, the contract layer**, and **no toolchain installation**.
See [`plan.md`](plan.md) §3 and [`research.md`](research.md).

**The Flutter client itself is BLOCKED and its row stays open.** No Flutter, no Dart, no Xcode on
this machine (`research.md §6`), so `flutter run`, a simulator screenshot, an audio-routing check and
the stated physical-device matrix are all unproducible here. Recording that is the point; MIG5 set
the precedent that BLOCKED is a valid result and a green-looking substitute is not.

**Task-ID prefix `F` collides with `F1…F5` in `specs/api-golden-fixtures/tasks.md`** —
`update-ledger.sh` matches across every spec file, so those rows would flip too. Using **`OC`**
(OpenAPI Contract) instead. Checked: `F*`, `MIG*`, `N1…N6`, `P0.1…P7.6`, `PAR*`, `T*` exist; `OC*`
collides with nothing.

---

## OC1 — One hand-authored OpenAPI 3.1 contract for every route

`packages/contracts/openapi.yaml` + `tests/contract/coverage.test.mjs` (6 tests).

Hand-authored, **not generated from the Rust**: a contract derived from the implementation cannot
disagree with it, and a contract that cannot disagree is not a contract.

**Acceptance:** every route in `lib.rs` appears exactly once and nothing is contracted that is not
served — asserted in **both** directions, so adding a route fails the gate until it is contracted.

- [x] OC1 — OpenAPI contract — All routes contracted, coverage asserted in both directions.

---

## OC2 — Validate the contract against real responses

`scripts/validate-openapi-responses.mjs` replays the 26 committed Phase 5 fixtures through `ajv`
validators compiled from the spec's components.

**Acceptance:** the validator has teeth — proven by mutating the spec and watching it fail, not by
reading it:

```
require a field the responses lack  → $ must have required property 'thisFieldDoesNotExist'
change totalSessions to a string    → /totalSessions must be string
restored                            → ok  the contract matches every real response it covers
```

Result: **14 validated, 0 divergences, 12 skipped** (no JSON schema for that status, or
`x-unvalidated`). The skip count is printed, never hidden.

- [x] OC2 — Validated contract — ajv against committed real responses, with a mutation check.

---

## OC3 — Byte-level vectors a Dart client will need

Extends MIG3's `packages/contracts/fixtures/canonical-gates.json`, which already carried the Arabic
UTF-8 anchor. Two cases added for what Arabic alone does **not** catch:

| vector | the bug it catches |
|---|---|
| **supplementary-plane** (U+1EE00 U+1EE01 — 2 code points, 4 UTF-16 units) | iterating by code UNIT and splitting a surrogate pair; the halves encode to U+FFFD and the digest changes |
| **NFC-unstable** (U+0628 U+0651 U+064E) | a client that "tidies up" with `.normalize()`. Carries `wrongIfNormalized`, the digest normalizing actually produces |

**Acceptance:** the TS suite asserts the NFC vector really is unstable *and* that normalizing yields
exactly `wrongIfNormalized` — a trap that could pass vacuously is not a trap. 31 tests green.

- [x] OC3 — Byte vectors — Supplementary-plane and NFC-unstable cases, with non-vacuous traps.

---

## OC4 — Gate it, and state the Dart gap honestly

`coverage.test.mjs` and the OC2 validator join the hermetic `verify.sh` steps — neither needs a
database or a running service.

**The Dart half has no runner on this machine.** It is recorded here as a named gap, not skipped
silently and not counted as covered: the corpus is *readable* by a Dart client, and nothing has
proven a Dart client reads it.

**Acceptance:** `bash scripts/verify.sh` green with both new steps in the log.

- [x] OC4 — Gate — Wire the contract layer into verify.sh; record the Dart gap.

---

## Findings

### 1. 🔴 Phase 7's route count was wrong: 38, not 34

Phase 7's research counted method+path pairs by matching `axum::routing::<verb>(`. Five methods are
registered **chained** on an existing MethodRouter — `axum::routing::get(h).post(h2)` — and were
invisible to that pattern:

```
POST /v1/recitation-sessions
POST /v1/recitation-sessions/{id}/alignments
POST /v1/scholar-approvals
POST /v1/agent-runs
POST /v1/learner/progress
```

Found because the hand-authored contract listed them and `coverage.test.mjs` reported them as
"contracted but not served". **Two independently-derived lists disagreeing is exactly what a contract
is for** — the parser was wrong and the hand-written list was right.

Consequence: Phase 7's *"9 of 34 pairs have no executable check"* understated the denominator. The
uncovered set itself is unchanged (those five all have parity coverage), but the ratio was wrong and
is corrected here rather than left to propagate.

### 2. The literal Arabic reordered itself while I was adding the NFC vector

The first version of the NFC-unstable case stored its input as a literal string. It came back with
the **normalized** digest — the marks had been reordered in transit. Exactly the PR #258 lesson
(literal combining marks are the wrong medium), reproduced while writing the test that exists to
catch it. Now stored as `inputCodepoints`, which no tool can silently reorder.

### 3. `x-unvalidated: true` marks 15 of 38 operations

Those have permissive response schemas because no committed evidence of their shape exists. **A
permissive schema that was not marked would validate anything and read as coverage** — the false
green this repo keeps rediscovering. The count is pinned by a test so it can only shrink
deliberately.

---

## Not in this phase, and not started

- **The Flutter client.** Blocked (see the header). No widgets, no screens, no `pubspec.yaml`.
- **`openapi-typescript` / `quicktype` codegen.** Generating TS types adds nothing while the server
  is Rust, and Dart models are worthless without a Dart runner to check them.
- **Kurdish i18n.** 381 strings exist; `ckb`/`ar`/`tr` are all `EMPTY_TRANSLATION`. It is the
  product's largest user-facing gap, it is unchanged by any client rewrite, and it needs a Kurdish
  speaker rather than a model guessing at religious register (`research.md §4`).
- **Auth changes.** §3.3's bearer/Keychain work is backend security on a login surface the owner has
  disabled.

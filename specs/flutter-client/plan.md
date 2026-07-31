# Plan — Phase 8: the Flutter client

**Status: awaiting approval. Nothing below has been implemented.**

Approved-by: _(unsigned — no work starts until a human signs this line)_

Source: `specs/flutter-node-migration/plan.md` Part 6, phase 8 — *"Flutter client: mushaf, audio,
bearer auth, i18n, a11y. 12–20 weeks. Gate: parity checklist; physical-device matrix."*
Design input: that plan's **Part 3** and **Part 4**. Evidence: [`research.md`](research.md).

---

## 1. Three findings, and one of them is a hard block

**(a) The strongest argument for Flutter was already withdrawn — by this plan.** §3.1 rules out QCF
page fonts and says so directly: *"This also weakens the strongest argument for Flutter."* Its
prescribed fallback is HarfBuzz shaping with a properly licensed Uthmani font — **which is what the
web client already does** (Amiri, Arabic subsets confirmed in the built bundle). So the mushaf-quality
gain is a hypothesis to test, not a reason in hand.

**(b) There is no client-side oracle.** Phases 5–7 built 26 fixture steps, 56 parity tests and
cross-language ticket vectors. None of them can check a client. Phase 7 learned what porting without
an oracle costs on **one route**; this is 10,773 lines of behaviour with none.

**(c) 🔴 The toolchain is absent.** No Flutter, no Dart, no fvm, **no Xcode** — only Command Line
Tools, so `simctl` does not exist and there is no iOS Simulator. There are no physical devices.

> **Phase 8's stated gate — "physical-device matrix" — cannot be produced on this machine.**
> Neither can a simulator screenshot, an audio-routing check, or `flutter run`.

That is a blocker on the work, not an argument against it. Recording it as BLOCKED rather than
delivering something adjacent and calling it Phase 8 is the same rule MIG5 followed.

## 2. What that leaves, and it is not nothing

The Flutter **app** is blocked. The Flutter **contract** is not: `dart test` runs pure Dart with no
platform toolchain, and the Flutter SDK is a user-space tarball needing no admin.

`migration/plan.md` Part 4 already specifies that layer — OpenAPI 3.1 as one hand-authored contract,
`openapi-typescript` for TS types, `ajv` for runtime validation, `quicktype` for Dart models, golden
vectors read by `dart test` — and says of it:

> *"do this even if the migration is cancelled."*

It is also exactly what finding (b) says is missing, and what Phase 7 concluded is the binding
constraint: **oracle coverage, not client code.**

## 3. Scope — the decision for the approver

| option | scope | cost | blocked? |
|---|---|---|---|
| **A — contract layer only** ⭐ | OpenAPI 3.1 for the 34 routes + TS types + `ajv` runtime validators + a Dart-readable golden-vector corpus, verified against the LIVE service | **1–2 weeks** | **no** |
| **B — A, plus a Flutter rendering/audio spike** | + install Flutter SDK, one mushaf screen, screenshot A/B vs the web client, `record`→PCM16 path | 3–4 weeks | **partly** — needs Xcode (~15 GB, App Store, your admin password) for anything on-device |
| **C — the full phase** | mushaf, audio, bearer auth, i18n, a11y, device matrix | 12–20 weeks | **yes** — cannot start here |
| **D — defer Phase 8; do the Kurdish i18n instead** | translate 381 strings | 1 week + a translator | no |

**Recommendation: A.** It is the only option that is fully unblocked, it is the prerequisite for B
and C both, it is what Part 4 says to do regardless of the migration's fate, and it closes the gap
Phase 7 identified as binding. If you then install Xcode, B becomes available with A already done.

**D is not mine to choose** — it is out of Phase 8's scope. But `research.md §4` is the honest
context: the app aiming to be number one *for Kurdish* currently shows Kurdish learners an English
interface, and no client rewrite changes that. Naming it once; not re-litigating it.

## 4. Tasks (option A)

### F1 — One hand-authored OpenAPI 3.1 contract for all 34 routes

`specs/flutter-client/openapi.yaml`. 3.1's Schema Object *is* JSON Schema 2020-12, so one file serves
route contracts and raw schemas both.

Hand-authored, **not generated from the Rust**: a contract derived from the implementation cannot
disagree with it, and a contract that cannot disagree is not a contract.

**Acceptance:** every one of the 34 method+path pairs measured in Phase 7 appears exactly once, with
its real status codes — asserted by a test that parses `lib.rs`, so a route added later fails the
gate. Same shape as `tests/api-parity/coverage.json`.

### F2 — Validate the contract against the LIVE service

The 26 Phase 5 fixtures and the 56 Phase 6 parity responses are replayed through `ajv` compiled from
the OpenAPI components.

**This is the task that gives the contract teeth.** A hand-authored spec that has never met a real
response is documentation. Every divergence is recorded the way Phase 5 recorded 200-not-201 —
the finding is written down, not smoothed away by editing the spec to match.

**Acceptance:** the validator runs against a live service and every divergence is either fixed in the
spec or recorded with a reason. Executed, with the output committed.

### F3 — The Dart-readable golden-vector corpus

Extend `packages/contracts/fixtures/` to cover the 10 safety functions as `{fn, input, expected}`
JSON — the same shape MIG3 established — so a future Dart port asserts against the identical file the
TS suite uses.

Include the byte-source trap `migration/plan.md` Part 4 names: `utf8.encode` is the only correct
source for Arabic, because `String.codeUnits` is UTF-16 and silently wrong. A vector with a
supplementary-plane character makes that fail loudly rather than subtly.

**Acceptance:** the TS suite consumes the corpus (not hardcoded literals), and the corpus contains at
least one vector that a UTF-16 byte source would get wrong.

### F4 — Gate it, and state the Dart gap honestly

Wire F1–F3 into `verify.sh`. The Dart half has **no runner on this machine**, so it is recorded as an
explicit, named gap — not skipped silently, and not claimed as covered.

**Acceptance:** `bash scripts/verify.sh` green; a test asserts the recorded gap list matches reality,
so it goes stale loudly when Dart does arrive.

## 5. Non-goals

- **No Flutter app, no widgets, no screens.** Blocked, and saying otherwise would be fiction.
- **No toolchain installation without your say-so.** Flutter is ~1 GB and Xcode ~15 GB with an admin
  password I do not have.
- **No i18n translation.** Kurdish text needs a Kurdish speaker, not a model that guesses at
  religious register.
- **No auth changes.** §3.3's bearer/Keychain work is backend security on a surface you have
  disabled.
- **No changes to `apps/web` or `apps/mobile`.**

## 6. Risks

| risk | mitigation |
|---|---|
| A hand-authored spec drifts from the service | F2 validates it against live responses; F1's coverage test fails when a route is added |
| The contract becomes a second source of truth that disagrees with the fixtures | fixtures stay authoritative for *values*; the spec is authoritative for *shapes*. Divergences are recorded, never reconciled by editing the oracle |
| Option A is useful only if the migration proceeds | the opposite — it is an API contract for **any** client, including the React one, and Part 4 says to build it regardless |
| Doing A signals Phase 8 is "done" | it is not, and `tasks.md` will say so in the ledger: the Flutter client remains **BLOCKED**, not complete |

## 7. What this phase does NOT establish

- **Not** that Flutter renders the mushaf better. That needs option B and a machine that can run it.
- **Not** anything about mobile audio, iOS routing, or on-device performance.
- **Not** parity for any client — it establishes the contract a parity check would use.
- **Not** progress toward a Kurdish-language UI.

## 8. Questions for the approver

1. **Scope: A (contract layer, recommended), B (A + a Flutter spike), C (full phase), or D (defer)?**
2. **Should I install the Flutter SDK?** It is user-space and needs no admin, and it would let the
   Dart half of F3 actually run. **Xcode is separate** — ~15 GB via the App Store and your password,
   and without it there is no simulator and no device work at all.

"Approved" alone means **A**, and no toolchain installation.

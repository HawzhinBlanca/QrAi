# Kurdish (Sorani) localisation — Tasks

Scope approved 2026-07-31: **option A** — pipeline plus gated drafts for the non-religious registers.
See [`plan.md`](plan.md) §4.

**0 of 381 strings are reviewed.** That is the correct state on day one: this delivers the path to a
Kurdish app, not the app. Nothing here reaches a learner until a Sorani speaker promotes it.

**Task-ID prefix `K`.** Checked against `CU*`, `F*`, `MIG*`, `N*`, `OC*`, `P0.1…P7.6`, `PAR*`, `T*` —
no collision.

---

## K1 — Classify all 381 strings

`specs/kurdish-i18n/registers.json` + `tests/i18n/registers.test.mjs` (6 tests).

| register | count | who translates it |
|---|---|---|
| `ui` | **166** | any fluent Sorani speaker |
| `product` | **101** | a speaker who understands spaced repetition and consent |
| `religious` | **112** | **needs religious literacy — never AI-drafted** |
| `brand` | **2** | nobody; "Quran AI" is not translated in any language |

**Corrected while implementing:** the plan estimated ~80 religious strings; the measured figure is
**112**. The classifier is deliberately over-inclusive — over-including costs a smaller draft,
under-including costs a learner being taught a wrong word. It pulls in `"Scholar"`, `"Recitation"`
and `"Recite"`, and that is right: **مامۆستا / زانا / شێخ** for *scholar*, and
**خوێندنەوە / تیلاوەت** for *recitation*, are genuine register decisions, not lookups.

**Acceptance:** classification covers `en.json` exactly in both directions; every `religious` and
`brand` entry carries a reason; a spot-check asserts the protected terms all landed in `religious`.

- [x] K1 — Classify — Four registers over all 381 strings, drift-proofed both ways.

---

## K2 — The parity gate

`tests/i18n/locale-parity.test.mjs` (8 tests). Six of them assert the gate **rejects**:

an orphan key · a dropped `{{variable}}` · a **renamed** `{{variable}}` · a value identical to the
English · an empty string · `_one` without `_other`.

The seventh asserts it **accepts a partial locale**, because a half-reviewed file is the designed
state — if that ever failed, reviewers would be pushed to bulk-approve, which is exactly what the
review gate exists to prevent.

**"Identical to the English" is the subtle one.** It looks translated to a coverage count and renders
English to a learner. Omitting the key renders the same English and claims nothing.

- [x] K2 — Parity gate — Six rejection rules, each demonstrated failing.

---

## K3 — Drafts, gated

`specs/kurdish-i18n/drafts/ckb.draft.json` — **51 strings**, every one `ai-suggested`, none loaded by
the app. `tests/i18n/drafts.test.mjs` (10 tests).

**51 of 267 draftable, not ~300.** Stopping early was deliberate: a fluent-sounding wrong draft
anchors a reviewer, so drafting fewer strings carefully beats padding the count with declining
confidence. The remaining 216 draftable strings are longer sentences where my confidence drops and a
reviewer is better served by a blank than by a guess.

`note` marks every term with competing Kurdish forms — including the one real inconsistency the
drafts contain: `فێرخواز` (learner) vs `خوێندکار` (student) across `sidebar.nav.learner` and
`topBar.roleLabelDefault`. That is left for the reviewer to settle, flagged rather than silently
chosen.

**The boundary is enforced, not promised.** The builder REFUSES a religious or brand key — verified
by attempting to draft `tajweedPanel.title`:

```
REFUSED:
  tajweedPanel.title: religious — must NOT be drafted
exit=1
```

**Acceptance:** zero religious/brand drafts; nothing under `apps/` imports the file; every draft
records the English it came from, keeps its interpolation, and is in Perso-Arabic script.

- [x] K3 — Drafts — 51 gated Sorani drafts; the religious boundary machine-checked.

---

## K4 — The reviewer workflow

`scripts/i18n-review.mjs` — `--list`, `--promote <key>`, `--status`, or the next pending draft with
its English, its note, and the reminder that correcting it is expected.

**There is deliberately no `--promote-all`.** One string at a time is the mechanism, not an
inconvenience in it. Promotion also **refuses a stale draft** whose English has changed since it was
written, so nobody approves a translation of a sentence that no longer exists.

`docs/TRANSLATION_REVIEW.md` states plainly that a run of rejections is a healthy signal, and that a
test going red after a promotion is fixed by asserting on the key — **never** by reverting the
translation, because a test pinning English text is asserting the app is untranslated.

- [x] K4 — Reviewer workflow — One-at-a-time promotion, stale drafts refused.

---

## K5 — Wire it up, count honestly

`apps/web/src/locales/ckb.json` created as `{}` and loaded in place of `EMPTY_TRANSLATION`. With an
empty file the behaviour is **byte-identical to today**; each promoted string changes exactly one
label.

The comment in `i18n/index.ts` was rewritten — leaving prose saying the language is deliberately
untranslated, beside code that loads translations, is the documentation drift this repo keeps
finding.

**Acceptance:** `bash scripts/verify.sh` → VERIFY OK; `--status` reports **0 of 381 (0.0%)**.

- [x] K5 — Wire up — Load reviewed strings only; report coverage honestly.

---

## Findings

### 1. Kurdish was already the default, resolving to English

`i18n/index.ts` sets `lng: "ckb"`. Sorani is not an option a learner has to find — it is what the app
**starts in**, with all 381 strings falling back to English. The gap was never a missing feature; it
was the primary experience.

### 2. My own guard was broken, and passed while guarding nothing

`drafts.test.mjs` asserts nothing under `apps/` imports the draft file. The first version grepped for
the bare filename and flagged `i18n/index.ts`, whose **comment** explains where drafts live — a false
positive that would have got that comment deleted.

Tightening it to `(import|require|from)[^\n]*ckb\.draft` **broke it silently**: in POSIX ERE a bracket
expression is literal, so `[^\n]` means "not a backslash and not the letter **n**" — and the path
contains `kurdish-i18n`. The pattern could not span it, matched nothing, and the test passed.

Caught only by injecting a real import and watching the test *not* fail. Fixed to `.*`, then verified
in both directions. **A guard that has never been shown to fire is not a guard** — this one nearly
shipped as decoration.

### 3. The religious set is 112, not ~80

Measured, not estimated. See K1.

---

## Not done, and needing a person

- **330 strings have no draft**: 112 religious + 2 brand (never AI-drafted, by design) and 216
  draftable ones I stopped short of.
- **0 strings are reviewed.** This needs a **Sorani speaker**, and the religious register needs one
  with **religious literacy**. Neither exists in this repository, and no further engineering changes
  that.
- **The other 8 locales** stay `EMPTY_TRANSLATION`. The same pipeline serves them when a reviewer for
  each exists; doing eight at once means reviewing none.

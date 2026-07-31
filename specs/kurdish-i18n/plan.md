# Plan — Kurdish (Sorani) localisation

**Status: awaiting approval. Nothing below has been implemented.**

Approved-by: _(unsigned — no work starts until a human signs this line)_

Not part of the Flutter/Node migration. This is the product's largest user-facing gap, surfaced
repeatedly across Phases 5–9 and never in scope until now. Evidence: [`research.md`](research.md).

---

## 1. The problem, stated exactly

`i18n/index.ts` sets `lng: "ckb"`. **Sorani Kurdish is the language the app starts in**, and all 381
strings fall back to English. A learner in Erbil opens a Kurdish-first Quran app and reads an English
interface — today, by default, as the primary experience.

## 2. The existing decision is right, and it is also stuck

The same file records why nothing was translated:

> "shipping AI-guessed Kurdish Sorani … for a religious-education product without native-speaker
> review would be **worse than being honest that it isn't translated yet**."

I agree, and this plan does not reverse it. But that decision blocks the bad path **without opening
the good one**: there is no mechanism to get from "untranslated" to "reviewed by a native speaker",
so the gap has stayed exactly where it was while nine phases of infrastructure went past it.

**The deliverable is that mechanism, not the translation.**

## 3. The repo already owns the right pattern

`ReviewStatus` (`packages/contracts`) is `draft | ai-suggested | teacher-review-required |
teacher-reviewed | scholar-approved | blocked`, and `canShowLearnerFacingAiOutput` already enforces
that **only** `teacher-reviewed` or `scholar-approved` content reaches a learner.

An AI-drafted translation is `ai-suggested` **by definition**. Gating it exactly as tajweed content
is gated is not a new policy — it is the existing one applied to the surface that has been waiting
for it.

**The concrete mechanism, and it needs no runtime change:**

```
specs/kurdish-i18n/drafts/ckb.draft.json   ai-suggested — NOT loaded by the app, ever
apps/web/src/locales/ckb.json              reviewed only — this is what ships
```

A reviewer promotes a string by moving it. `fallbackLng: "en"` already renders English for anything
absent, so a half-reviewed file is a **partially Kurdish app**, never a broken one. Progress is
countable: *n of 381 reviewed*.

## 4. Scope — the decision for the approver

The unavoidable question is whether I draft the Sorani at all.

| option | what I produce | risk |
|---|---|---|
| **A — pipeline + drafts, gated** ⭐ | the machinery, **plus** an `ai-suggested` draft for the 2 non-religious registers (~300 strings), left unloaded until a human promotes each one | a reviewer may anchor on a fluent-sounding wrong draft — real, and mitigated in §5 |
| **B — pipeline only** | the machinery and an empty draft file for a human to fill | slower for the reviewer, zero anchoring risk |
| **C — translate and ship** | 381 Sorani strings straight into `ckb.json` | **I will not do this.** It is exactly what the existing decision forbids, in a religious-education product |

**Recommendation: A**, with the religious register (§5) excluded from drafting entirely.

**C is not on the table** even if asked. Drafting behind a gate and shipping unreviewed are different
acts; the first accelerates a reviewer, the second substitutes for one.

## 5. The line I will not cross, and how the plan enforces it

Three registers (`research.md §7`). I will draft the first two and **not the third**:

| register | ~count | drafted? |
|---|---|---|
| UI chrome — buttons, labels, errors | ~230 | yes |
| product concepts — progress, review scheduling, consent | ~70 | yes, flagged for a fluent reviewer |
| **religious / tajweed** — `tajweedPanel.*`, `practiceSteps.*`, makhraj / madd / ghunnah / qalqalah, and anything naming an act of worship | **~80** | **no — left empty, marked `needs-religious-review`** |

For the third group a wrong word does not read awkwardly, it **teaches a learner something false**
about recitation. Those terms are Arabic technical vocabulary whose Kurdish usage is established in
some cases and contested in others, and choosing between them is a scholarly judgement, not a
translation one. `docs/SCHOLAR_REVIEW.md` already governs this class of content.

**A test enforces the boundary**: any key classified `needs-religious-review` that has a non-empty
draft fails the gate. The line is machine-checked, not a promise.

## 6. Tasks

### K1 — Classify all 381 strings, and gate the classification

`specs/kurdish-i18n/registers.json` — every key tagged `ui`, `product`, or `religious`, with a reason
on every `religious` one.

**Acceptance:** a test asserts the classification covers **exactly** the keys in `en.json` — no key
unclassified, none stale — and that every `religious` entry carries a reason. Same shape as PAR6's
coverage ledger, and it fails when someone adds a string without deciding what it is.

### K2 — The parity gate

`tests/i18n/locale-parity.test.mjs`, over any locale file that exists:

- no key absent from `en.json` (an orphan is a typo nobody will ever see fail);
- `{{interpolation}}` variables **identical** to English — a dropped `{{nextReview}}` renders a
  sentence with a hole in it, and no type system catches that;
- plural keys keep both `_one` and `_other`;
- **no value byte-identical to the English** — that is an untranslated string masquerading as a
  translated one, which is worse than absence because the fallback would have handled absence
  honestly.

**Acceptance:** each rule demonstrated failing on a deliberately broken fixture. A parity gate that
has never rejected anything is decoration.

### K3 — Draft the `ui` and `product` registers

`specs/kurdish-i18n/drafts/ckb.draft.json`. Sorani, Perso-Arabic script, Erbil register.

Every entry carries `{ value, status: "ai-suggested", note? }` — `note` where I am uncertain or where
a term has competing forms, because **an unflagged guess is the failure mode here.**

**Acceptance:** the file exists, is NOT imported anywhere in `apps/`, and contains **zero** entries
for `religious` keys. Both asserted.

### K4 — The reviewer workflow

`scripts/i18n-review.mjs` — shows a reviewer one string at a time (English, draft, key, screen it
appears on), and `--promote <key>` moves an approved string into `apps/web/src/locales/ckb.json`.

Plus `docs/TRANSLATION_REVIEW.md`: what to check, what "religious" means here, and that **rejecting a
draft outright is the expected outcome for many of them** — a reviewer who feels they are rubber-
stamping my work will rubber-stamp it.

**Acceptance:** promoting a key moves it and leaves the draft consistent; a promoted key immediately
satisfies K2's parity rules or the promotion is refused.

### K5 — Wire it up, and count honestly

`ckb.json` is loaded by `i18n/index.ts` **in place of** `EMPTY_TRANSLATION`, and the comment there is
rewritten to describe the new reality rather than the old one.

**Acceptance:** `bash scripts/verify.sh` green; the app renders reviewed Kurdish and falls back to
English for the rest; a coverage line reports *n of 381 reviewed*, starting at **0**.

## 7. Non-goals

- **The other 7 languages.** `ar`, `tr`, `ur`, `id`, `ms`, `fr`, `de` stay `EMPTY_TRANSLATION`. The
  same pipeline serves them later; doing eight at once means reviewing none.
- **Kurmanji (`kmr`).** A different language for this purpose, not a spelling variant
  (`research.md §6`).
- **Quranic text and translations.** `packages/quran-data` is canonical, checksum-verified, and NFC-
  unstable on purpose. Nothing here touches it.
- **Backend strings.** API error messages are wire contract (Phase 5/7) and are not localised.
- **Shipping any unreviewed string to a learner.**

## 8. Risks

| risk | mitigation |
|---|---|
| **A fluent-sounding wrong draft gets rubber-stamped** — the central risk of option A | religious register never drafted; `note` on every uncertain term; the reviewer doc states rejection is expected; drafts live outside `apps/` so approval is an explicit act |
| A religious term slips into the drafted set | K1 classifies with reasons, K3 asserts zero religious drafts — machine-checked, not promised |
| Half-translated UI looks broken | it cannot: `fallbackLng: "en"` already renders English for anything absent |
| Interpolation dropped in translation | K2 asserts variable parity |
| The reviewer never arrives and this rots | the mechanism is inert and harmless at 0 reviewed — the app behaves exactly as it does today |

## 9. What this does NOT do

- **It does not make the app Kurdish.** It makes a reviewed Kurdish app *reachable*, at 0 strings on
  day one.
- **It does not substitute for a Kurdish speaker**, and nothing in it should be read as doing so.
- **It touches no religious terminology**, which is precisely the part a learner would notice most.

## 10. Question for the approver

**Scope: A (pipeline + gated drafts for the non-religious registers, recommended), or B (pipeline
only, you supply all strings)?**

"Approved" alone means **A**. Either way, **no unreviewed string reaches a learner**, and I will not
draft religious or tajweed terminology in either option.

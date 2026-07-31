# Research — Kurdish (Sorani) localisation

Measured against `d515e21`.

---

## 1. The corpus

```bash
node -e "…walk apps/web/src/locales/en.json"   # 381 leaf strings, 25 groups
```

| | |
|---|---|
| leaf strings | **381** |
| top-level groups | 25 (`topBar`, `sidebar`, `login`, `consent`, `practiceSteps`, `tajweedPanel`, …) |
| with `{{interpolation}}` | **27** |
| plural keys (`_one` / `_other`) | 2 (`modeBanner.correctionText_*`) |
| languages catalogued | **9** (`SUPPORTED_LANGUAGE_CODES`) |
| languages with any translation | **1** (English) |

## 2. 🔴 Kurdish is the DEFAULT language, and it resolves to English

`apps/web/src/i18n/index.ts`:

```ts
resources: { en: { translation: en }, ckb: EMPTY_TRANSLATION, ar: …, tr: …, ur: …, id: …, ms: …, fr: …, de: … },
lng: "ckb",
fallbackLng: "en",
```

`lng: "ckb"` — **Sorani Kurdish is what the app starts in.** Every one of the 381 keys then falls back
to English. So a learner in Erbil opens a Kurdish-first Quran app and reads an English interface,
today, by default. That is not a missing nice-to-have; it is the primary user-facing surface.

## 3. The existing decision is deliberate, and this plan must not override it

The same file carries an explicit rationale:

> "shipping AI-guessed Kurdish Sorani / Arabic / … UI text for a religious-education product without
> native-speaker review would be **worse than being honest that it isn't translated yet** (the same
> principle already applied to tajweed content requiring scholar review…)"

That is correct and I am not proposing to reverse it. The gap is not the decision — it is that **no
mechanism exists to get from "untranslated" to "reviewed by a native speaker."** The decision blocks
the bad path without opening the good one, so nothing has moved.

## 4. The repo already owns the vocabulary for exactly this

`packages/contracts/src/index.ts:5-11`:

```ts
export type ReviewStatus =
  | "draft" | "ai-suggested" | "teacher-review-required"
  | "teacher-reviewed" | "scholar-approved" | "blocked";
```

And `canShowLearnerFacingAiOutput` already enforces that **only** `teacher-reviewed` or
`scholar-approved` content reaches a learner — pinned by the golden-vector corpus MIG3 built.

An AI-drafted translation is `ai-suggested` by definition. Applying the review gate the repo already
uses for tajweed content is not a new policy; it is the existing one, applied to the surface that has
been waiting for it.

## 5. RTL already works

`apps/web/src/data/platform.ts:52-73` carries `direction: "ltr" | "rtl"` per language, `App.tsx:371`
sets `document.documentElement.dir` from it, `styles.css` uses CSS logical properties, and
`App.smoke.test.tsx:898` asserts `dir === "rtl"`.

`QuranReader.tsx:121` already renders the verse translation as `dir="rtl" lang="ckb"`. So the layout
is ready for Sorani; only the strings are missing.

## 6. Which Kurdish, and why it matters

The pilot tenant is **`hikmah-pilot-erbil`** — Erbil, in the Kurdistan Region of Iraq, where **Sorani
(`ckb`)** is the dominant written variety and uses a Perso-Arabic script (hence RTL). `ckb` is
therefore the right target, and it is what the app already defaults to.

**Kurmanji (`kmr`) is a different language for this purpose** — different script conventions in most
of its range, and not mutually intelligible in writing with Sorani. It is not in
`SUPPORTED_LANGUAGE_CODES` and is out of scope here; a Bahdini/Kurmanji audience would be a separate
decision, not a variant spelling.

## 7. The strings are not uniform, and the difference decides who can translate them

Sampling shows at least three registers:

| register | example | who can translate it |
|---|---|---|
| plain UI chrome | `topBar.*`, `sidebar.*`, buttons, `errorBoundary.*` | any fluent Sorani speaker |
| product concepts | `completePanel.bodySaved` — *"Progress saved. Your next review stays scheduled for {{nextReview}}."* | a fluent speaker who understands spaced repetition |
| **religious / tajweed** | `tajweedPanel.empty` — *"Recite to get tajweed feedback (makhraj, madd, ghunnah)."* | a speaker with **religious literacy** — these are Arabic technical terms with established (and contested) Kurdish usage |

The third register is where a wrong choice actively teaches a learner something false, and it is
exactly the class `docs/SCHOLAR_REVIEW.md` already governs for tajweed content.

## 8. What is machine-checkable, and what is not

| property | checkable? |
|---|---|
| every `ckb` key exists in `en` (no orphans) | yes |
| `{{interpolation}}` variables match the English exactly | yes |
| plural forms present for plural keys | yes |
| no key left as the English string verbatim (silent non-translation) | yes |
| RTL renders correctly | partly — `dir` is assertable, visual correctness is not |
| **the Sorani is correct, idiomatic, and religiously appropriate** | **no — this is the whole point** |

Four of six are mechanical. The one that matters is not, which is why the deliverable has to be a
review pipeline rather than a translation.

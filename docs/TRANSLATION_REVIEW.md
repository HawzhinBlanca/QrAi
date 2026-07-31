# Reviewing a translation

You are the gate. Nothing in `specs/kurdish-i18n/drafts/` reaches a learner until you move it.

```bash
node scripts/i18n-review.mjs                 # the next draft awaiting you
node scripts/i18n-review.mjs --list          # all of them
node scripts/i18n-review.mjs --promote <key> # approve ONE string
node scripts/i18n-review.mjs --status        # honest coverage
```

## Rejecting is the expected outcome for many of these

The drafts were written by a model with **no way to verify its Sorani is idiomatic for Erbil**. It
does not know how your learners speak, which loanwords feel natural, or which register a religious-
education product should use. Treat every draft as a first guess by someone who has never been in the
room.

If you find yourself approving most of them quickly, something has gone wrong — either the drafts are
better than they have any right to be, or the review has become a formality. **A run of rejections is
a healthy signal, not a problem with the process.**

There is deliberately **no `--promote-all`.** One string at a time is the whole mechanism.

## What to check, in order

1. **Is it right?** Not "is it understandable" — is it what a Kurdish speaker would actually say.
2. **Is the register right?** This is a Qur'an learning app used by children and adults. Formal, not
   casual; plain, not academic.
3. **Are the `{{variables}}` intact?** `{{minutes}}`, `{{nextReview}}` are substituted at runtime. A
   dropped one renders a sentence with a hole in it. The gate catches this, but catching it here is
   cheaper.
4. **Is it consistent?** If `sidebar.nav.learner` is فێرخواز, `login.roleLearner` must not be
   خوێندکار. Several drafts carry a `note` flagging exactly this.

## What is NOT drafted, and why

**~112 strings are classified `religious` and were never drafted at all** — tajweed terminology
(makhraj, madd, ghunnah, qalqalah), and anything naming an act of worship or the act of recitation.

For those, a wrong word does not read awkwardly — **it teaches a learner something false**. They are
Arabic technical terms whose Kurdish usage is established in some cases and contested in others, and
choosing between them is a scholarly judgement, not a translation one. They need someone with
religious literacy, and they are governed by the same review policy as tajweed content
(`docs/SCHOLAR_REVIEW.md`).

The 2 `brand` strings ("Quran AI") are not translated in any language.

Write them yourself into `apps/web/src/locales/ckb.json`, or hand them to a scholar. The gate will
check their shape either way.

## Nothing you leave undone breaks anything

`fallbackLng: "en"` renders the real English string for every key you have not reviewed. A locale with
3 strings in it is a **partly Kurdish app**, never a broken one. You can stop at any point.

## If a test goes red after you promote a string

Some smoke tests assert on English label text while the app runs under `lng: "ckb"` — they pass
*because of* the fallback. Once you promote a string, the assertion breaks. **That is correct.**

Fix it by asserting on the translation key or a `data-testid`. **Never by reverting the
translation** — a test that pins English text is asserting the app is untranslated.

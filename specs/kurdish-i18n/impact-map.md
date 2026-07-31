# Impact map — Kurdish (Sorani) localisation

Scope as approved. Under **B** the file list is identical; `drafts/ckb.draft.json` ships empty.

---

## 1. New — no existing callers

| path | what | task |
|---|---|---|
| `specs/kurdish-i18n/registers.json` | every key tagged `ui` / `product` / `religious`, with reasons | K1 |
| `tests/i18n/registers.test.mjs` | asserts the classification matches `en.json` exactly | K1 |
| `tests/i18n/locale-parity.test.mjs` | key, interpolation, plural and not-just-English rules | K2 |
| `specs/kurdish-i18n/drafts/ckb.draft.json` | `ai-suggested` drafts — **never imported by `apps/`** | K3 |
| `scripts/i18n-review.mjs` | reviewer CLI: show one string, `--promote <key>` | K4 |
| `docs/TRANSLATION_REVIEW.md` | what to check, and that rejecting is expected | K4 |
| `apps/web/src/locales/ckb.json` | **reviewed strings only** — starts as `{}` | K5 |

## 2. Modified — and one of them is load-bearing

### `apps/web/src/i18n/index.ts` (K5)

**Callers: the entire web client.** `ckb: EMPTY_TRANSLATION` becomes `ckb: { translation: ckb }`.

This is the only change with runtime effect, and its blast radius is bounded by a property that
already holds: `fallbackLng: "en"` renders English for every absent key. With `ckb.json = {}` the
behaviour is **byte-identical to today**. Each promoted string changes exactly one rendered label.

The file's comment must be rewritten. Leaving prose that says the language is deliberately
untranslated, next to code that loads translations, is the documentation drift this repo keeps
finding — the comment is the reason the decision was legible in the first place.

### `apps/web/src/App.smoke.test.tsx`

**Caller: the `test: ts` gate step.** It asserts `document.documentElement.dir === "rtl"` and, in
places, on English label text while running under `lng: "ckb"`. Those assertions pass **because of
the fallback**. Once a promoted Kurdish string replaces one, the assertion breaks — correctly.

**Rule: fix such a test by asserting on the key or on `data-testid`, never by reverting the
translation.** A test that pins English text is asserting the app is untranslated.

### `scripts/verify.sh` (K5)

Two hermetic test files on the explicit-path line. Behind the CODYSTEM guard; needs the
`.codystem-allow-self-edit` sentinel, as PAR5, N1, F4 and CU4 did.

### `apps/web/src/locales/en.json`

**Not modified** — but it becomes the schema every other locale is checked against, so adding a key
now also means classifying it (K1) or the gate fails. Deliberate, and documented at the top of
`registers.json` with the one-line fix.

## 3. Read, not modified

`packages/contracts` — `ReviewStatus` and `SUPPORTED_LANGUAGE_CODES` are reused as the vocabulary
(`ai-suggested` for drafts, `teacher-reviewed` to promote). No change to either; this plan borrows
the pattern rather than inventing a parallel one.

## 4. Not touched

- **`packages/quran-data`** — canonical Quranic text, checksum-verified and deliberately NFC-unstable.
  Nothing here reads or writes it, and no translation pipeline may ever normalise it.
- **The other 8 locales** — still `EMPTY_TRANSLATION`.
- **Backend strings** — API error messages are wire contract (Phase 5 and 7 both pin them) and are
  not localised.
- **`apps/mobile`** — the Expo stub has its own strings and is out of scope.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **A wrong-but-fluent Kurdish string is promoted** | **a learner, silently — and in the religious register they may believe it** | religious keys are never drafted (K1 + K3, machine-checked); `note` on uncertain terms; a reviewer doc that expects rejection |
| A draft leaks into the shipped locale | nobody — it would just render | drafts live outside `apps/`; a test asserts nothing under `apps/` imports the draft file |
| Interpolation dropped in a promoted string | a learner, as a sentence with a hole | K2's variable-parity rule |
| A smoke test is "fixed" by reverting a translation | nobody | §2's rule, stated in `TRANSLATION_REVIEW.md` |
| Half-translated UI | nobody — it is the designed state | `fallbackLng: "en"` |

## 6. What has no mitigation

**This produces zero reviewed Kurdish strings.** It produces the path to them, and that path needs a
Sorani speaker with religious literacy who does not exist in this repository. Until that person
arrives, the app renders exactly what it renders today.

That is the honest ceiling, and no amount of further engineering raises it.

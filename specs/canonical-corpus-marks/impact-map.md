# Impact Map — stop scoring non-recited mushaf marks

Companion to `plan.md` (AGENTS.md step 2). Caller counts measured at main `462ebe8` by grep across
`apps/`, `packages/`, `services/`, excluding `node_modules`.

---

## 1. New symbol

### `isNonRecitedMark(text: string): boolean` — `packages/contracts/src/index.ts`

New export, no existing callers. Will be called from exactly three places (T2, T3, T4).

**Adjacent symbol NOT to touch:** `canonicalWordPayload` (same file, `:342`). It hashes `record.id`
and `record.wordIndex`. Adding classification to it would invalidate `verifyCanonicalWord` for every
word after the first mark in an ayah across 89 of 114 surahs. The T1 test pins this: a known word's
checksum must be byte-identical before and after.

---

## 2. Modified symbols and their callers

### `alignWords(canonicalWords, recognizedWords)` — `services/ml-inference/alignment.js:59`

| Caller | Type |
|---|---|
| `services/ml-inference/server.mjs:522` | **production — the only one** |
| `services/ml-inference/alignment.test.mjs` (5 cases: 42, 54, 73, 77, 102) | tests |

Single production caller. The 5 existing test cases use ayahs with no marks, so they must pass
**unchanged** — if any needs editing, the change is wrong (that would mean altering behaviour for
real words).

### `QuranReader` — `apps/web/src/components/QuranReader.tsx`

| Referencing file | Type |
|---|---|
| `apps/web/src/components/PracticeFlow.tsx` | production consumer |

One consumer. The change is internal to the render of `verse.words.map(...)` (`:73-92`) — the props
contract is unchanged, so `PracticeFlow` needs no edit. Verify that claim during T4 rather than
assuming it.

### The transcript filter — `apps/web/src/App.tsx:763`

Not an exported symbol; a local `const recitedAligned` inside `runAlignmentAndTajweed` (`:733`).
No external callers. Consumed two lines later at `:775` (`transcript:`) and `:778`
(`buildTimingsByWordId`).

**Coupled invariant:** `buildTimingsByWordId(recitedAligned, aligned)` is positional and bails to
0/0 when counts mismatch (documented at `api.ts:386`). Filtering marks must keep both sides in step
or all timings are silently lost. T3 asserts this.

---

## 3. Database — nothing changes

| Object | Effect |
|---|---|
| `canonical_words` | **unchanged** — no rows, ids, or `word_index` values modified |
| `word_alignments.word_id` (the ONLY FK to `canonical_words`, `0001_core_schema.sql:119`) | **unchanged** |
| `tajweed_findings.alignment_id` → `word_alignments` | unchanged (transitive, holds no word id) |
| `teacher_reviews.finding_id` → `tajweed_findings` | unchanged (transitive) |
| Migrations | **none added** |
| Checksums | **none recomputed** |

This is the whole point of choosing classification over re-indexing.

---

## 4. Tests to run per task

| Task | New tests | Existing suites that must stay green |
|---|---|---|
| T1 | `t-t1-marks` + fixture cases in `canonical-gates.json` | `packages/contracts` (19 tests incl. the MIG3 fixture runner) |
| T2 | `t-t2-align` | `alignment.test.mjs` (5 cases, **unchanged**), `server.test.mjs` |
| T3 | `t-t3-transcript` | `apps/web` suite, `App.smoke.test.tsx` |
| T4 | `t-t4-render` | `LearnerHome.a11y.test.tsx`, `PrivacyConsent.a11y.test.tsx` (axe) |

Full gate after each: `bash scripts/verify.sh` → must exit 0, including the Python suites gated in
MIG5 (27/27 + 6/6).

---

## 5. What could break that the tests above would NOT catch

Named so it is a known gap, not a surprise:

- **A real word wrongly classified as a mark** would stop being scored, silently. Mitigation: T1
  asserts the "every character is a mark" rule, and that a word with a *trailing* mark is still a
  word. But no test enumerates all 82,456 tokens — a corpus-wide sweep asserting exactly 4,578
  classify true would close this, and is cheap. **Recommend adding it to T1.**
- **Pre-existing `word_alignments` rows that already scored marks** stay in the DB as junk. Out of
  scope (plan.md §6 Q3); not created by this change, not fixed by it.

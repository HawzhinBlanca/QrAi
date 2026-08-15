# Research — non-recited marks in the canonical word corpus

**Phase 3 of** `specs/flutter-node-migration/plan.md`. Read-only; no code written.
**Measured at** main `462ebe8`. Every number below is from a command, not an estimate.

---

## 1. The defect

4,578 of 82,456 canonical "word" tokens are **not words**. They are mushaf annotation symbols that
carry real word ids (`surah:ayah:index`), are rendered as scored, tappable word buttons, and are fed
to the forced aligner as things to find in the audio.

Exact composition (measured across `packages/quran-data/src/data/full-quran/*.json`):

| Codepoint | Count | What it is |
|---|---|---|
| `U+06DA` | 1,972 | small high jeem — waqf (pause permissible) |
| `U+06D6` | 1,682 | small high sad-lam-alef — waqf |
| `U+06D7` | 603 | small high qaf-lam-alef — waqf |
| `U+06DE` | 199 | start of rub' el hizb |
| `U+06D9` | 68 | small high lam-alef — waqf (do not pause) |
| `U+06D8` | 22 | small high meem — waqf (compulsory pause) |
| `U+06E9` | 15 | place of sajdah |
| `U+06DB` | 12 | small high three dots |
| `U+06DC` | 5 | small high seen |
| **Total** | **4,578** | across **89 of 114** surahs |

Position: **199** sit at word index 0 (all `U+06DE`, hizb markers opening an ayah); **4,379** sit
mid-ayah.

Consequences, both real:
1. A learner is scored on symbols they must never recite — "missed" on a sajdah sign.
2. The aligner is asked to locate audio for 4,578 silent tokens, which distorts the timing of the
   token itself *and every neighbour*.

---

## 2. The critical finding: removal is the WRONG fix

The migration plan (and the audit that fed it) proposed re-deriving `canonical_words` to **exclude**
the marks and **re-index** every word id. Research says that is both the most expensive option and
the wrong one on the merits.

### 2.1 These marks are legitimate mushaf content

Waqf signs tell a reciter where they may, must, or must not pause. That is **recitation
instruction** — arguably more pedagogically valuable than the words for a learner practising
tajweed. Deleting them from the corpus would mean the app stops *showing* them, degrading mushaf
fidelity to fix a scoring bug.

**The marks belong in the display. They must not be in the scoring.** Those are different concerns
and the current schema conflates them.

### 2.2 Re-indexing invalidates every checksum

`canonicalWordPayload` ([contracts/index.ts:342](../../packages/contracts/src/index.ts#L342)) hashes:

```
record.id | quranRef.display | record.ayahId | record.wordIndex | record.text | sourceId | edition | scriptType | importVersion
```

Both **`id` and `wordIndex`** are inside the checksum. Re-indexing changes both for every word after
the first mark in an ayah — across 89 surahs. `verifyCanonicalWord` would fail on all of them until
every checksum is recomputed, which is exactly the "canonical text changed" alarm the system exists
to raise. Re-indexing makes the integrity check cry wolf at scale.

### 2.3 The FK blast radius is one column, not three

The plan claimed `word_alignments` / `tajweed_findings` / `teacher_reviews` all FK into word ids.
Measured — **only one column** references `canonical_words`:

```
infra/migrations/0001_core_schema.sql:119   word_id text not null references canonical_words(id)
```

The chain is transitive, not direct:
`canonical_words` ← `word_alignments.word_id` ← `tajweed_findings.alignment_id` ←
`teacher_reviews.finding_id`. Only `word_alignments` holds a word id at all.

So the FK migration is narrower than estimated — but §2.2 means we should avoid needing one.

---

## 3. Where marks actually leak into scoring (the real fix sites)

### 3.1 The aligner never sees the word list — it sees a string

`services/asr-inference/server.py:453` does `words = req.transcript.split()`. The forced aligner
receives a **whitespace-delimited string**, not canonical word records. So marks reach it only
because they are joined into that string.

### 3.2 The transcript is built at one line, next to a filter that already has the right reasoning

`apps/web/src/App.tsx:763-775`:

```ts
// Only words the learner ACTUALLY RECITED: exclude "extra" (spoken but not canonical) AND
// "missed" (canonical but not spoken). Feeding a missed word into the aligner asks it to place
// a word that isn't in the audio, distorting that word's span and every neighbor's.
const recitedAligned = alignment.alignments.filter(
  (a) => a.status !== "extra" && a.status !== "missed",
);
...
transcript: recitedAligned.map((a) => a.canonicalText).join(" "),
```

**That comment is already the argument for excluding marks** — a waqf sign is never in the audio.
The concept exists; marks simply were not considered. This is an extension of correct existing
logic, not new machinery.

### 3.3 Alignment status is assigned upstream

`services/ml-inference/alignment.js:59` `alignWords(canonicalWords, recognizedWords)` does the
Levenshtein/similarity matching that assigns `matched` / `misread` / `missed`. A mark passed in here
can only ever score badly — it has no audio to match. **Filtering here prevents a bad status from
ever existing**, which is stronger than filtering it out later.

### 3.4 The UI renders every word as a scored button

`apps/web/src/components/QuranReader.tsx:73-92` emits one
`<button aria-label="{text} {status}" class="word-token status-{status}">` per token, with click,
active, selected and reciting states. A mark therefore gets a status class, a status announcement to
a screen reader, and a tap target.

---

## 4. Recommended approach: classify, don't delete

Add a token classification to the corpus and honour it at the four sites above. Marks stay in the
text with their ids intact; they stop being scored.

Why this is the right trade, not merely the cheap one:

| | Re-index (original plan) | Classify (recommended) |
|---|---|---|
| Learner scored on marks | fixed | fixed |
| Aligner given silent tokens | fixed | fixed |
| Waqf signs still shown to reciter | **lost** | preserved |
| Checksums | **all invalidated across 89 surahs** | untouched |
| `word_alignments.word_id` FK rows | **must be migrated** | untouched |
| Word ids stable for the Flutter/Node port | **no** | yes |
| Estimated effort | 4–6 weeks | ~1 week |

The classification must **not** enter `canonicalWordPayload`, or it re-invalidates every checksum —
the same trap as §2.2. It is metadata *about* a token, not part of the canonical identity of one.

---

## 5. Open questions for the plan

1. **Where does classification live?** Derived at read time from the codepoint set (no migration, no
   corpus edit, single source of truth) versus a persisted `token_type` column (queryable, but a
   migration and a second place for the truth to live). Deriving is cheaper and cannot drift.
2. **How should a mark render?** A non-interactive `<span>` preserves the visual mushaf and removes
   the tap target and status announcement. Needs an accessibility decision: screen readers should
   probably announce waqf signs as pause guidance, not skip them silently — that is a real
   pedagogical signal for a blind reciter.
3. **Do existing `word_alignments` rows reference marks?** If the pilot DB has scored-mark rows they
   are junk data; needs a count before deciding whether to purge.
4. **Do the 199 index-0 hizb markers need different handling?** They open an ayah rather than
   interrupting it, so they may warrant a distinct display treatment.

---

## 6. What this research did NOT establish

- Whether a scholar considers any of these marks *recitable* in some qira'ah. The codepoint list is
  Unicode-documented annotation, but the classification of a mark as "never recited" is a domain
  claim, and §5.2's screen-reader question is pedagogical. Flag for review, do not assume.
- Whether the ml-inference filter changes any currently-passing test's expectations — needs the
  impact map.

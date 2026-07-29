# Plan — stop scoring non-recited mushaf marks

**Status: APPROVED 2026-07-29** by the repo owner in session (AGENTS.md step 2 gate satisfied).
**Research:** `research.md` (same directory). **Measured at** main `462ebe8`.
**Phase 3 of** `specs/flutter-node-migration/plan.md`.

**Approved-by:** repo owner (HawzhinBlanca), 2026-07-29, in session — scope T1-T4 as written below.

---

## 1. Approach, and why it differs from what Phase 3 originally said

The migration plan proposed **deleting the 4,578 mark tokens and re-indexing every word id** (4–6
weeks, schema-breaking). Research says do the opposite: **keep them, classify them, and stop scoring
them** (~1 week, no schema break).

Three findings drove the change:

1. **Waqf signs are recitation instruction.** They tell a reciter where they may, must, or must not
   pause — pedagogically valuable for exactly this app's users. Deleting them means the app stops
   *showing* them. The bug is that display and scoring are conflated, not that the marks exist.
2. **`wordIndex` and `id` are both inside the checksum** ([contracts/index.ts:342](../../packages/contracts/src/index.ts#L342)).
   Re-indexing invalidates `verifyCanonicalWord` for every word after the first mark in an ayah,
   across 89 of 114 surahs — making the canonical-integrity alarm fire at scale for a change that is
   not a text corruption.
3. **The FK blast radius is one column**, not three: only `word_alignments.word_id` references
   `canonical_words`. Narrower than estimated — but (2) means we should avoid needing a migration at
   all.

**Decision: derive classification at read time from the codepoint set. No migration, no corpus edit.**
A persisted `token_type` column was considered and rejected: it creates a second place for the truth
to live and can drift from the data, for no gain here (the set is fixed and Unicode-documented).

**Hard constraint:** the classification must never enter `canonicalWordPayload`. It is metadata
*about* a token, not part of its canonical identity. Putting it in the payload reintroduces the exact
checksum invalidation this plan avoids.

---

## 2. Files and symbols to change

| # | File | Change |
|---|---|---|
| T1 | `packages/contracts/src/index.ts` | NEW `isNonRecitedMark(text: string): boolean` — pure, exported, no I/O |
| T2 | `services/ml-inference/alignment.js` | `alignWords` skips mark tokens so no status is ever assigned to one |
| T3 | `apps/web/src/App.tsx:763` | extend the existing `recitedAligned` filter to drop marks before building the transcript |
| T4 | `apps/web/src/components/QuranReader.tsx:73` | render a mark as a non-interactive `<span>` with pause-guidance semantics, not a scored `<button>` |

Nothing else. No SQL migration, no corpus regeneration, no re-indexing.

---

## 3. Tasks (one at a time, `verify.sh` green between each)

### T1 — `isNonRecitedMark` in contracts

The single source of truth, in the package both the web app and (later) any Node/Dart port already
depend on.

Covers the 9 codepoints measured in research.md §1: `U+06D6`–`U+06DC`, `U+06DD`, `U+06DE`, `U+06E9`.
A token is a mark iff **every** character is in that set (a real word containing a mark is not a
mark — it is a word, and must stay scored).

- **Tests (`t-t1-marks`)**: each of the 9 codepoints classified true; real words (`بِسْمِ`, `ٱللَّهِ`)
  false; empty string false; a word with a trailing mark false (it is still a word); a
  whitespace-only string false.
- **Fixture parity**: add the cases to `packages/contracts/fixtures/canonical-gates.json` so any
  future Node/Dart port asserts the same set — the corpus built in MIG3 exists for exactly this.
- **Must NOT** touch `canonicalWordPayload` (§1 hard constraint). A test asserts an existing word's
  checksum is byte-identical before and after this change.

### T2 — `alignWords` never scores a mark

`services/ml-inference/alignment.js:59`, one production caller (`server.mjs:522`).

Marks are excluded from the alignment matrix so no `matched`/`misread`/`missed` status can ever be
produced for one. Stronger than filtering downstream: a bad status never exists to leak.

- **Tests (`t-t2-align`)**: an ayah containing a waqf mark yields alignments only for real words;
  the surrounding words keep the same statuses they had *without* the mark present (proves the mark
  was not just dropped but stopped perturbing its neighbours — the distortion research.md §3.2
  names); the existing 5 `alignment.test.mjs` cases still pass unchanged.

### T3 — the transcript excludes marks

`apps/web/src/App.tsx:763`. This extends a filter whose own comment already states the rationale —
*"Feeding a missed word into the aligner asks it to place a word that isn't in the audio, distorting
that word's span and every neighbor's."* A waqf sign is never in the audio.

Belt-and-braces with T2 (which should mean no mark ever reaches here), and deliberately so: this is
the boundary to the Python aligner, and `server.py:453` splits a raw string with no validation.

- **Tests (`t-t3-transcript`)**: given alignments containing a mark, the transcript string contains
  no mark codepoint; `buildTimingsByWordId`'s positional count still lines up (the helper bails to
  0/0 on mismatch, so a count skew would silently lose all timings).

### T4 — marks render as guidance, not as scored words

`apps/web/src/components/QuranReader.tsx:73-92`.

A mark becomes a non-interactive `<span class="waqf-mark">`: no `status-*` class, no click handler,
no tap target. **Accessibility decision (needs owner/a11y confirmation, see §6):** it keeps an
`aria-label` announcing pause guidance rather than being `aria-hidden`. A waqf sign is real
information for a blind reciter; silently hiding it would remove a pedagogical signal, which is a
different kind of harm from announcing it as a "missed word."

- **Tests (`t-t4-render`)**: a verse containing a mark renders no `<button>` for it; renders the mark
  glyph (still visible — mushaf fidelity preserved); the axe suites in
  `LearnerHome.a11y.test.tsx` stay green.

---

## 4. Impact map

See `impact-map.md`. Summary: 4 files, 1 new exported function, 1 modified function with a single
production caller, 2 modified components. **Zero SQL. Zero FK rows touched. Zero checksums changed.**

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Classification enters the checksum → 89 surahs' integrity alarms fire | T1 test asserts a known word's checksum is byte-identical pre/post |
| Filtering marks skews the positional timing map | T3 test asserts `buildTimingsByWordId` counts still align |
| Existing `word_alignments` rows already score marks (junk data) | §6 Q3 — count before deciding; out of scope for this plan, named not hidden |
| A mark is recitable in some qira'ah | §6 Q1 — scholar question, not an engineering one |
| Dropping marks perturbs neighbour statuses | T2 test compares statuses with and without the mark present |

---

## 6. Open questions — answer before or during, not after

1. **Scholar (blocking for T2's premise, not for the code):** are all 9 codepoints non-recited in
   every qira'ah the pilot supports? The list is Unicode-documented *annotation*, but "never recited"
   is a domain claim I should not make alone.
2. **A11y/owner (blocking T4's final shape):** should a screen reader announce waqf signs as pause
   guidance (proposed) or skip them? This is pedagogy, not markup.
3. **Data (not blocking):** how many existing `word_alignments` rows point at a mark? Needs a count
   against the pilot DB. If non-zero they are junk; purging is a separate, smaller task.
4. **Deferred:** the 199 `U+06DE` hizb markers sit at word index 0 and open an ayah rather than
   interrupting it. Same classification, possibly a different visual treatment — noted, not scoped
   here.

---

## 7. Definition of done

- `bash scripts/verify.sh` exits 0 after **each** of T1–T4.
- `scripts/update-ledger.sh` flipped each row because verify passed — never by judgment.
- CI green on the PR.
- A learner practising an ayah with a waqf mark: sees the mark, is not scored on it, and the
  surrounding words' timings are unchanged from an ayah without one.

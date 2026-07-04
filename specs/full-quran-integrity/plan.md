# Plan — full-Quran text integrity

Approved-by:

Add an INDEPENDENT integrity check alongside (not replacing) `validateFullQuranData`. Additive and
server-only; no runtime behavior change to the app.

## Changes
### [MODIFY] `packages/quran-data/src/full-quran.ts`
- `CANONICAL_AYAH_COUNTS: Readonly<Record<number, number>>` — the 114 canonical Hafs ayah counts
  (independent ground truth; sum 6236).
- `FULL_QURAN_CONTENT_SHA256` — pinned checksum constant (drift detection).
- `computeFullQuranContentHash(): string` — SHA-256 over `surah:ayah:text\n` for all ayahs, in order.
- `checkSurahIntegrity(surah, expectedAyahCount): string[]` — PURE per-surah invariants: ayah count ==
  canonical; `numberOfAyahs` == ayahs.length; ayah numbers exactly 1..N contiguous; each text/word
  non-empty; `words.length == wordCount`; `sum(wordCount) == totalWords`.
- `validateFullQuranIntegrity(): { isValid, errors }` — sanity-checks the canonical table itself, then
  runs `checkSurahIntegrity` for surahs 1..114, then compares the content hash to the pinned constant.

### [MODIFY] `packages/quran-data/tests/full-quran.test.ts`
- `CANONICAL_AYAH_COUNTS` has 114 entries summing to 6236 and matches Al-Fatihah=7 / Al-Baqarah=286 /
  An-Nas=6.
- `validateFullQuranIntegrity()` returns `{ isValid: true, errors: [] }` on the real bundle.
- `computeFullQuranContentHash()` equals the pinned constant.
- NEGATIVE (teeth): `checkSurahIntegrity` on synthetic corrupt surahs catches — wrong ayah count, a
  gap/reorder in ayah numbering, empty text, `words.length != wordCount`, and `totalWords` mismatch.

### [ADD] `packages/quran-data/scripts/quran-content-hash.mjs`
- Regenerator for the pinned hash (run + review deliberately when the source edition changes).

## Verification
`bash scripts/verify.sh` = VERIFY OK. Then different-model review.

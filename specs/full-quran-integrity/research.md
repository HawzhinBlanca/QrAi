# Research — full-Quran text integrity

## The gap
`packages/quran-data/src/full-quran.ts::validateFullQuranData()` validates the bundled Quran against
the **manifest** (`manifest.json`) — but the manifest was generated FROM the same data files, so the
check is **self-referential**. If the source import (alquran.cloud `quran-uthmani`) was corrupted or
truncated, the manifest reflects the corruption and validation still passes. The only independent
anchors today are the constants `surahCount === 114` and `totalAyahs === 6236`; the latter is a *weak*
global checksum — two per-surah errors that cancel (one surah +1 ayah, another −1) keep the total 6236
and slip through. For a Quran platform this is the highest-stakes correctness risk: a single wrong or
missing ayah destroys credibility.

## Data shape (verified)
Each `surah-NNN.json`: `{ surahNumber, numberOfAyahs, totalWords, ayahs: [{ surahNumber, ayahNumber,
text, words: string[], wordCount }] }`. Ayahs are stored in order, `ayahNumber` 1..N.

## Editorial quirk (must not false-positive)
The alquran.cloud `quran-uthmani` edition **prepends the Bismillah to ayah 1's text** of every surah
(except At-Tawbah). E.g. An-Nas ayah 1 text has 8 words incl. `بِسْمِ ٱللَّهِ …`. So *word counts* are
inflated and non-standard — the integrity check must anchor on **ayah counts**, not word counts,
against external ground truth.

## Independent ground truth
The canonical **Hafs/Kufan per-surah ayah counts** (114 fixed numbers from the recitation tradition,
independent of the bundle) sum to exactly **6236** — verified, and every bundled surah's ayah count
already matches all 114 (0 mismatches). This is the anchor a real integrity check needs.

## Approach
1. Embed `CANONICAL_AYAH_COUNTS` (the 114 Hafs counts).
2. Per-surah structural invariants (contiguous ayah numbering, non-empty text/words, word-count
   totals) as a PURE function so negative tests can prove it has teeth.
3. Pin a SHA-256 over all 6236 ayah texts so any FUTURE drift/tampering in the count/structure-
   validated data is detected (current value `7d47065915b6dc645f6f975cb0eb1ec3d8f121869e911de97c69700c3fb6df5f`).

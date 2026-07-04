# Independent review — full-Quran text integrity

**Reviewer:** different-model (Claude Sonnet 5) adversarial review of the uncommitted feature on
`feat/full-quran-integrity`, verifying each claim against the real code and the bundled data files.

## Confirmed sound (verified, not assumed)
- **Ground truth is correct.** All 114 `CANONICAL_AYAH_COUNTS` match the standard Hafs/Kufan table at
  every spot-checked value (1=7, 2=286, 3=200, 4=176, 36=83, 67=30, 112=4, 114=6, …), sum to exactly
  **6236**, and match the bundled `surah-NNN.json` ayah counts with **zero mismatches across all 114**.
- **No false positives.** Ayah numbering is contiguous 1..N in every bundled file; no empty text/words;
  `computeFullQuranContentHash()` matches `FULL_QURAN_CONTENT_SHA256` byte-for-byte (independently
  recomputed). The check will not spuriously fail CI.

## Findings and resolutions
1. **[Medium] Wrong-surah-identity was undetectable.** `checkSurahIntegrity` only checked internal
   self-consistency (`ayah.surahNumber === surah.surahNumber`), never that the loaded surah *is* the one
   requested. With 24 canonical-ayah-count collision groups (e.g. 32/67/89 all have 30 ayahs), a
   file mixup swapping two surahs in a group passed the per-surah check. **Fixed:** `checkSurahIntegrity`
   now takes `expectedSurahNumber` and asserts `surah.surahNumber === expectedSurahNumber`; a new test
   proves it (`checkSurahIntegrity(goodSurah(), 67, 2)` → caught).
2. **[Medium] Structure-preserving ayah-content swap is invisible to the structural checker.** Inherent —
   swapping two equal-structure ayahs' content preserves every invariant, and a duplicate-text detector
   is not viable (Ar-Rahman legitimately repeats a refrain). **Resolved by documentation + a test:** the
   pinned content hash is the backstop for this class; a new test asserts the checker is (correctly)
   silent on such a swap, making the layering explicit and honest rather than claiming teeth it lacks.
3. **[Low] Doc overstated a sequencing guarantee.** The hash check runs independently of the structural
   results (errors combine), not gated behind them. **Fixed:** comment corrected.
4. **[Nitpick] Serialization delimiter assumption.** `:`/`\n` are unescaped in `surah:ayah:text`;
   verified no bundled ayah contains either. **Fixed:** documented the assumption on both serializers.

## Post-fix state
`bash scripts/verify.sh` = VERIFY OK; 29 quran-data tests pass (positive + 7 negative/teeth + boundary).

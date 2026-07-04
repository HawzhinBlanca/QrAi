# Tajweed correctness — bugs fixed + independent review

**Change:** three confirmed implementation bugs in the rule-based tajweed engine
(`services/ml-inference/tajweed.js`), plus its first unit-test suite
(`services/ml-inference/tajweed.test.mjs`, wired into `scripts/verify.sh`). Owner-approved scope:
"fix the confirmed bugs + add tests + review." Source edition: alquran.cloud quran-uthmani.

## The bugs (each confirmed empirically before fixing)
1. **Madd Tabii was keyed off the wrong diacritics.** It matched *tanween* (fathatain ً etc.) instead
   of the base harakat, so `قَالَ` (fatha+alef — the textbook natural madd) was NOT detected, while a
   rare/wrong tanween+vowel sequence was. Fixed to `fatha+alef / damma+waw / kasra+ya`.
2. **Ghunnah over-fired on a voweled noon.** The char class included a *bare* noon, so any word
   containing a noon (e.g. `نَا` "naa", noon+fatha) triggered ghunnah. Fixed to noon-sakin (bare or
   marked) or tanween.
3. **Inter-word noon rules fired on a voweled final noon.** `endsWithNoonSakin` stripped all harakat
   then matched a final noon, so `ٱلَّذِينَ` (ends نَ) wrongly triggered idgham/iqlab/ikhfa.

## Independent review (two rounds, different model — Claude Sonnet 5)

**Round 1 caught a CRITICAL regression I introduced.** My first fix for bug #3 required an *explicit*
sukoon (`/نْ$/`). But this edition writes the highest-frequency noon-sakin particles (مِن, مَن, عَن,
أَن, لَن, إِن) with a **bare** final noon (3,081 bare vs 912 with sukoon) — so inter-word
idgham/iqlab/ikhfa dropped to **zero across the whole Quran**. The review also found my tests masked
it (they used `مِنْ`/`مَنْ` sukoon forms that don't occur in the bundle) and flagged a pre-existing
tanween+annotation-mark gap.

**Fix:** a bare final noon is implicitly sakin in Uthmani orthography, and a voweled noon ends in the
*vowel* char, not the noon — so `/نْ?$/` (noon + optional sukoon at word end) detects bare + marked
sakin while still excluding voweled noons. Also: strip trailing Uthmani annotation marks (U+06D6–U+06ED)
so tanween followed by the small iqlab/ikhfa meem (e.g. `أَلِيمٌۢ`, 2:10) is detected; and per-word
ghunnah now treats a bare final noon as sakin. Tests rewritten to use the **real bundle word forms**.

**Round 2 confirmed the fix, exhaustively.** Running `analyzeAyah` over all 6,236 ayahs:
- Whole-Quran inter-word counts are non-zero and correctly ordered by frequency:
  **idgham 3527 > ikhfa 2546 > iqlab 407** (iqlab rarest — only before ب).
- **0 false positives** on 1,298 distinct voweled-final-noon words.
- All 69 distinct bare-final-noon forms verified genuinely noon-sakin; **0** noon-mushaddad traps.
- The annotation strip turns on **3,827** correct tanween detections and causes **0** regressions;
  it never removes a real letter.

## Post-fix state
`bash scripts/verify.sh` = VERIFY OK. `services/ml-inference/tajweed.test.mjs`: 9 assertions pass + 1
`todo` honestly flagging the one **known limitation** left for the scholar — ghunnah on noon/meem
**mushaddad** (نّ / مّ) is not yet implemented (the engine reports only "shaddah" for these). That is a
false-negative gap, not a wrong output, and is explicitly out of the approved scope.

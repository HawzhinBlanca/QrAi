-- What a tajweed finding was derived from.
--
-- `services/ml-inference/tajweed.js` `analyzeAyah(ayahId, words)` reads `word.text` and nothing
-- else. `word.text` is the canonical Uthmani text of the passage. The analyser inspects no audio, no
-- heard text, no timing and no pitch: it detects where a rule APPLIES in the Quran, which is a fact
-- about the passage and identical for every learner who ever recites it.
--
-- Those results are stored in a table whose own documentation describes a row as "this word, in this
-- recitation, was mispronounced", anchored to a `word_alignments` row as "the evidence that the word
-- was heard at all", and released to the learner after a teacher accepts it (ADR-0028). Nothing
-- anywhere recorded which of those two things a given finding actually is.
--
--   canonical-text  a rule applies at this position in the passage. True of the text, says nothing
--                   about how this learner recited it.
--   acoustic        derived from the learner's audio.
--
-- DEFAULT 'canonical-text', and today it is not merely the default — it is the only value anything
-- writes, because no acoustic analyser exists. That is the point of recording it: the column makes
-- the gap legible in the data instead of only in a doc comment, and a teacher deciding whether to
-- release a finding can see which kind they are looking at.
--
-- What this does NOT do is decide whether a canonical-text finding should be shown to a learner as
-- feedback about their recitation. That is a scholar's and the owner's call (SHIP_PLAN P3.4-P3.6).
-- This makes the call possible; it does not make it.
alter table tajweed_findings
  add column if not exists analysis_basis text not null default 'canonical-text'
    check (analysis_basis in ('canonical-text', 'acoustic'));

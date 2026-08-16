-- A finding derived from a FIXTURE is not a finding about a learner. (P3.2)
--
-- `ML_USE_GOLDEN_FIXTURES=1` makes ml-inference answer from `fixtures/golden-evals.json` instead of
-- analysing anything. Measured against the running service: the fixture path returns 8 alignments,
-- every one `status: "matched"` with `heardText === canonicalText` — a flawless recitation nobody
-- performed — plus 1 tajweed finding, where the real path on the same request returns 29 alignments
-- and 38 findings. The two responses carried an IDENTICAL set of top-level keys.
--
-- Those findings are persisted. `persist_tajweed_findings` wrote every one with
-- `analysis_basis = 'canonical-text'`, the same value a real analysis gets, so a teacher reviewing
-- one could not tell it from analysis of a child's recitation. The flag set once — a demo, a staging
-- box, a copied env file — contaminated the corpus permanently, and turning it off later does not
-- un-write the rows.
--
--   canonical-text  a rule applies at this position in the passage. True of the text, says nothing
--                   about how this learner recited it. (0025)
--   acoustic        derived from the learner's audio. (0025, still unwritten — no acoustic
--                   analyser exists)
--   fixture         derived from a stored fixture. Not about this learner, this session, or this
--                   recitation at all.
--
-- `fixture` is the WEAKEST claim of the three, which is why the value is safe to accept from the
-- upstream response while `canonical-text` stays a hardcoded literal. See the comment in
-- `persist_tajweed_findings`: a caller may only ever DOWNGRADE what its output claims to be.
--
-- The default is unchanged, for the same reason 0023 defaulted `transcript_source` to the weaker
-- `client-reported`: every existing row predates this value and none of them can be shown to be
-- fixture-derived, so the default must not silently reclassify the back catalogue in either
-- direction.
--
-- What this does NOT do is decide what a teacher or a learner should see when the basis is
-- `fixture`. Making the distinction recordable is the engineering half; ruling on it is P3.4-P3.6.
alter table tajweed_findings
  drop constraint if exists tajweed_findings_analysis_basis_check;

alter table tajweed_findings
  add constraint tajweed_findings_analysis_basis_check
    check (analysis_basis in ('canonical-text', 'acoustic', 'fixture'));

-- A reviewer or an exporter asking "which of these are real" should not scan the table.
create index if not exists idx_tajweed_findings_analysis_basis
  on tajweed_findings(analysis_basis);

-- Separate deterministic Quran instruction from learner-performance findings.
--
-- Historical `canonical-text` rows were produced by a detector that read only the canonical
-- Uthmani passage. They remain for audit, but are reclassified as `text-rule` and lose the numeric
-- zero that previously stood in for an unmeasured learner-performance confidence.

alter table tajweed_findings
  drop constraint if exists tajweed_findings_analysis_basis_check;

alter table tajweed_findings
  alter column analysis_basis drop default,
  alter column confidence drop not null;

update tajweed_findings
   set analysis_basis = 'text-rule', confidence = null
 where analysis_basis = 'canonical-text';

alter table tajweed_findings
  add constraint tajweed_findings_analysis_basis_check
    check (analysis_basis in ('text-rule', 'acoustic')),
  add constraint tajweed_findings_basis_confidence_check
    check (
      (analysis_basis = 'text-rule' and confidence is null)
      or
      (analysis_basis = 'acoustic' and confidence is not null)
    );

create index if not exists idx_tajweed_findings_acoustic_review
  on tajweed_findings(tenant_id, review_status, id)
  where analysis_basis = 'acoustic';

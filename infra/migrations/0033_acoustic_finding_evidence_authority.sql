-- New learner-performance findings must reference one exact, release-eligible acoustic evaluation.
-- Historical rows intentionally keep their nullable provenance from 0031: the trigger is scoped to
-- inserts and attribution-changing updates, so an old finding may still be reviewed or deleted but
-- can never be silently dressed in guessed evidence.

create or replace function app.require_release_eligible_tajweed_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.analysis_basis <> 'acoustic' then
    return new;
  end if;

  if new.evaluation_evidence_id is null then
    raise exception 'acoustic finding provenance must reference release-eligible evaluation evidence'
      using errcode = '23514';
  end if;

  perform 1
    from eval_runs er
   where er.tenant_id = new.tenant_id
     and er.model_version_id = new.model_version_id
     and er.evaluation_task = 'acoustic-tajweed'
     and er.evidence_kind = 'row-level-computed-evaluation'
     and er.evidence_eligibility = 'release-candidate'
     and er.release_eligible
     and er.passed
     and er.evidence_id = new.evaluation_evidence_id
     and er.evidence_payload_sha256 = new.evaluation_evidence_sha256
     and er.model_artifact_sha256 = new.model_artifact_sha256
     and er.dataset_version = new.acoustic_dataset_version
     and er.dataset_manifest_sha256 = new.acoustic_dataset_manifest_sha256
     and er.calibrator_id = new.calibrator_id
     and er.calibrator_artifact_sha256 = new.calibrator_artifact_sha256
   for key share;

  if not found then
    raise exception 'acoustic finding provenance does not match release-eligible evaluation evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger tajweed_findings_require_release_evidence
before insert or update of
  tenant_id,
  model_version_id,
  analysis_basis,
  evaluation_evidence_id,
  evaluation_evidence_sha256,
  model_artifact_sha256,
  acoustic_dataset_version,
  acoustic_dataset_manifest_sha256,
  calibrator_id,
  calibrator_artifact_sha256
on tajweed_findings
for each row execute function app.require_release_eligible_tajweed_evidence();

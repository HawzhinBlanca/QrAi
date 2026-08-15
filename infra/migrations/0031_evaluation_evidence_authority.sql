-- Add one fail-closed authority boundary to the existing evaluation and finding rows.
--
-- Historical aggregate rows remain queryable, but are explicitly regression fixtures and cannot
-- become release authority. New signed evidence is stored as one immutable payload plus the exact
-- identities needed for indexed matching. Tajweed provenance stays nullable for history; whenever
-- any part is supplied, the complete chain must reference one same-tenant evaluation row.

alter table eval_runs
  add column evaluation_task text,
  add column evidence_id text,
  add column evidence_kind text not null default 'legacy-aggregate',
  add column evidence_eligibility text not null default 'fixture-regression',
  add column release_eligible boolean not null default false,
  add column evidence_payload jsonb,
  add column evidence_payload_sha256 text,
  add column candidate_id text,
  add column model_artifact_sha256 text,
  add column dataset_manifest_sha256 text,
  add column split_manifest_sha256 text,
  add column split_id text,
  add column evaluator_version text,
  add column evaluator_source_sha256 text,
  add column evaluator_protocol_sha256 text,
  add column raw_row_manifest_sha256 text,
  add column raw_results_sha256 text,
  add column calibrator_id text,
  add column calibrator_artifact_sha256 text,
  add column signer_key_id text,
  add column signature_algorithm text,
  add column signature_base64url text,
  add column signed_at timestamptz,
  add column evaluation_counts jsonb,
  add column slice_metrics jsonb;

alter table eval_runs
  add constraint eval_runs_evaluation_task_check
    check (evaluation_task is null or evaluation_task in ('quran-word-alignment', 'acoustic-tajweed')),
  add constraint eval_runs_evidence_kind_check
    check (evidence_kind in ('legacy-aggregate', 'row-level-computed-evaluation')),
  add constraint eval_runs_evidence_eligibility_check
    check (evidence_eligibility in ('fixture-regression', 'research-only', 'release-candidate')),
  add constraint eval_runs_evidence_payload_check
    check (evidence_payload is null or jsonb_typeof(evidence_payload) = 'object'),
  add constraint eval_runs_evidence_payload_sha256_check
    check (evidence_payload_sha256 is null or evidence_payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_model_artifact_sha256_check
    check (model_artifact_sha256 is null or model_artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_dataset_manifest_sha256_check
    check (dataset_manifest_sha256 is null or dataset_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_split_manifest_sha256_check
    check (split_manifest_sha256 is null or split_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_evaluator_source_sha256_check
    check (evaluator_source_sha256 is null or evaluator_source_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_evaluator_protocol_sha256_check
    check (evaluator_protocol_sha256 is null or evaluator_protocol_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_raw_row_manifest_sha256_check
    check (raw_row_manifest_sha256 is null or raw_row_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_raw_results_sha256_check
    check (raw_results_sha256 is null or raw_results_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_calibrator_artifact_sha256_check
    check (calibrator_artifact_sha256 is null or calibrator_artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint eval_runs_signature_algorithm_check
    check (signature_algorithm is null or signature_algorithm = 'Ed25519'),
  add constraint eval_runs_signature_base64url_check
    check (signature_base64url is null or signature_base64url ~ '^[A-Za-z0-9_-]{86}$'),
  add constraint eval_runs_evaluation_counts_check
    check (evaluation_counts is null or jsonb_typeof(evaluation_counts) = 'object'),
  add constraint eval_runs_slice_metrics_check
    check (slice_metrics is null or jsonb_typeof(slice_metrics) = 'array'),
  add constraint eval_runs_calibrator_pair_check
    check ((calibrator_id is null) = (calibrator_artifact_sha256 is null)),
  add constraint eval_runs_evidence_completeness_check
    check (
      (
        evidence_payload is null
        and evidence_kind = 'legacy-aggregate'
        and evaluation_task is null
        and evidence_id is null
        and evidence_payload_sha256 is null
        and candidate_id is null
        and model_artifact_sha256 is null
        and dataset_manifest_sha256 is null
        and split_manifest_sha256 is null
        and split_id is null
        and evaluator_version is null
        and evaluator_source_sha256 is null
        and evaluator_protocol_sha256 is null
        and raw_row_manifest_sha256 is null
        and raw_results_sha256 is null
        and calibrator_id is null
        and calibrator_artifact_sha256 is null
        and signer_key_id is null
        and signature_algorithm is null
        and signature_base64url is null
        and signed_at is null
        and evaluation_counts is null
        and slice_metrics is null
      )
      or
      (
        evidence_payload is not null
        and evidence_kind = 'row-level-computed-evaluation'
        and evaluation_task is not null
        and evidence_id is not null
        and evidence_payload_sha256 is not null
        and candidate_id is not null
        and model_artifact_sha256 is not null
        and dataset_manifest_sha256 is not null
        and split_manifest_sha256 is not null
        and split_id is not null
        and evaluator_version is not null
        and evaluator_source_sha256 is not null
        and evaluator_protocol_sha256 is not null
        and raw_row_manifest_sha256 is not null
        and raw_results_sha256 is not null
        and signer_key_id is not null
        and signature_algorithm = 'Ed25519'
        and signature_base64url is not null
        and signed_at is not null
        and evaluation_counts is not null
        and slice_metrics is not null
      )
    ),
  add constraint eval_runs_release_eligibility_check
    check (
      not release_eligible
      or (
        evidence_kind = 'row-level-computed-evaluation'
        and evidence_eligibility = 'release-candidate'
        and evidence_payload is not null
        and calibrator_id is not null
        and calibrator_artifact_sha256 is not null
      )
    ),
  add constraint eval_runs_evidence_attribution_unique
    unique (
      tenant_id,
      evidence_id,
      evidence_payload_sha256,
      model_artifact_sha256,
      dataset_version,
      dataset_manifest_sha256,
      calibrator_id,
      calibrator_artifact_sha256
    );

create or replace function app.reject_eval_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.evaluation_task, old.evidence_id, old.evidence_kind, old.evidence_eligibility,
    old.release_eligible, old.evidence_payload, old.evidence_payload_sha256, old.candidate_id,
    old.model_artifact_sha256, old.dataset_manifest_sha256, old.split_manifest_sha256,
    old.split_id, old.evaluator_version, old.evaluator_source_sha256,
    old.evaluator_protocol_sha256, old.raw_row_manifest_sha256, old.raw_results_sha256,
    old.calibrator_id, old.calibrator_artifact_sha256, old.signer_key_id,
    old.signature_algorithm, old.signature_base64url, old.signed_at, old.evaluation_counts,
    old.slice_metrics
  ) is distinct from row(
    new.evaluation_task, new.evidence_id, new.evidence_kind, new.evidence_eligibility,
    new.release_eligible, new.evidence_payload, new.evidence_payload_sha256, new.candidate_id,
    new.model_artifact_sha256, new.dataset_manifest_sha256, new.split_manifest_sha256,
    new.split_id, new.evaluator_version, new.evaluator_source_sha256,
    new.evaluator_protocol_sha256, new.raw_row_manifest_sha256, new.raw_results_sha256,
    new.calibrator_id, new.calibrator_artifact_sha256, new.signer_key_id,
    new.signature_algorithm, new.signature_base64url, new.signed_at, new.evaluation_counts,
    new.slice_metrics
  ) then
    raise exception 'evaluation evidence is immutable';
  end if;
  return new;
end;
$$;

create trigger eval_runs_evidence_immutable
before update on eval_runs
for each row execute function app.reject_eval_evidence_mutation();

alter table tajweed_findings
  add column evaluation_evidence_id text,
  add column evaluation_evidence_sha256 text,
  add column model_artifact_sha256 text,
  add column acoustic_dataset_version text,
  add column acoustic_dataset_manifest_sha256 text,
  add column calibrator_id text,
  add column calibrator_artifact_sha256 text;

alter table tajweed_findings
  add constraint tajweed_findings_evaluation_evidence_sha256_check
    check (evaluation_evidence_sha256 is null or evaluation_evidence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint tajweed_findings_model_artifact_sha256_check
    check (model_artifact_sha256 is null or model_artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint tajweed_findings_dataset_manifest_sha256_check
    check (
      acoustic_dataset_manifest_sha256 is null
      or acoustic_dataset_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'
    ),
  add constraint tajweed_findings_calibrator_artifact_sha256_check
    check (calibrator_artifact_sha256 is null or calibrator_artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  add constraint tajweed_findings_evidence_attribution_completeness_check
    check (
      (
        evaluation_evidence_id is null
        and evaluation_evidence_sha256 is null
        and model_artifact_sha256 is null
        and acoustic_dataset_version is null
        and acoustic_dataset_manifest_sha256 is null
        and calibrator_id is null
        and calibrator_artifact_sha256 is null
      )
      or
      (
        evaluation_evidence_id is not null
        and evaluation_evidence_sha256 is not null
        and model_artifact_sha256 is not null
        and acoustic_dataset_version is not null
        and acoustic_dataset_manifest_sha256 is not null
        and calibrator_id is not null
        and calibrator_artifact_sha256 is not null
      )
    ),
  add constraint tajweed_findings_evidence_attribution_fk
    foreign key (
      tenant_id,
      evaluation_evidence_id,
      evaluation_evidence_sha256,
      model_artifact_sha256,
      acoustic_dataset_version,
      acoustic_dataset_manifest_sha256,
      calibrator_id,
      calibrator_artifact_sha256
    ) references eval_runs (
      tenant_id,
      evidence_id,
      evidence_payload_sha256,
      model_artifact_sha256,
      dataset_version,
      dataset_manifest_sha256,
      calibrator_id,
      calibrator_artifact_sha256
    );

create or replace function app.reject_tajweed_provenance_mutation()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.evaluation_evidence_id, old.evaluation_evidence_sha256, old.model_artifact_sha256,
    old.acoustic_dataset_version, old.acoustic_dataset_manifest_sha256, old.calibrator_id,
    old.calibrator_artifact_sha256
  ) is distinct from row(
    new.evaluation_evidence_id, new.evaluation_evidence_sha256, new.model_artifact_sha256,
    new.acoustic_dataset_version, new.acoustic_dataset_manifest_sha256, new.calibrator_id,
    new.calibrator_artifact_sha256
  ) then
    raise exception 'tajweed finding provenance is immutable';
  end if;
  return new;
end;
$$;

create trigger tajweed_findings_provenance_immutable
before update on tajweed_findings
for each row execute function app.reject_tajweed_provenance_mutation();

create index idx_eval_runs_tenant_evidence
  on eval_runs(tenant_id, evidence_id)
  where evidence_id is not null;

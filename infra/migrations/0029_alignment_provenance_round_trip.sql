-- Persist the complete producer chain for server-derived recitation alignments.
--
-- The historical `model-v0.3` registry row is an evaluation-era compatibility record, while the
-- running producer identifies itself as `quran-constrained-levenshtein@1`. New sessions must bind
-- to the implementation that can actually answer their finalization request. Existing sessions are
-- deliberately not rewritten: changing their model foreign key would fabricate provenance.

alter table model_versions
  add column if not exists runtime_selected boolean not null default false;

insert into model_versions (id, kind, version, status, runtime_selected)
values ('quran-constrained-levenshtein@1', 'alignment', '1', 'draft', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from model_versions
    where id = 'quran-constrained-levenshtein@1'
      and kind = 'alignment'
      and version = '1'
  ) then
    raise exception 'quran-constrained-levenshtein@1 collides with an incompatible model registry row';
  end if;
end $$;

update model_versions
   set runtime_selected = (id = 'quran-constrained-levenshtein@1')
 where kind = 'alignment';

create unique index if not exists idx_model_versions_one_runtime_selected_per_kind
  on model_versions(kind) where runtime_selected;

-- Existing runs are retained exactly as they were. Their missing component document is represented
-- by NULL, never by a guessed default. New finalization runs populate both fields.
alter table alignment_runs
  add column if not exists transcript_source text
    check (transcript_source in ('server-derived', 'client-reported')),
  add column if not exists model_attribution jsonb
    check (model_attribution is null or jsonb_typeof(model_attribution) = 'object');

-- A word can only point to a run for the same tenant AND the same session. The primary key on the
-- run id alone would stop an unknown id, but would not make that ownership relationship explicit.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'alignment_runs'::regclass
      and conname = 'alignment_runs_id_tenant_session_unique'
  ) then
    alter table alignment_runs
      add constraint alignment_runs_id_tenant_session_unique
      unique (id, tenant_id, session_id);
  end if;
end $$;

alter table word_alignments
  add column if not exists alignment_run_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'word_alignments'::regclass
      and conname = 'word_alignments_run_tenant_session_fk'
  ) then
    alter table word_alignments
      add constraint word_alignments_run_tenant_session_fk
      foreign key (alignment_run_id, tenant_id, session_id)
      references alignment_runs(id, tenant_id, session_id);
  end if;
end $$;

create index if not exists idx_word_alignments_alignment_run
  on word_alignments(tenant_id, alignment_run_id)
  where alignment_run_id is not null;

-- Historical server-derived rows predate run persistence, so this is NOT VALID. PostgreSQL still
-- enforces it for every new INSERT/UPDATE; later validation can happen only after the old records
-- are adjudicated rather than assigned invented provenance.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'word_alignments'::regclass
      and conname = 'word_alignments_server_derived_has_run'
  ) then
    alter table word_alignments
      add constraint word_alignments_server_derived_has_run
      check (transcript_source <> 'server-derived' or alignment_run_id is not null)
      not valid;
  end if;
end $$;

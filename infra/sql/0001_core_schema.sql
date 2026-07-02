create table institutions (
  id text primary key,
  name text not null,
  region text not null,
  created_at timestamptz not null default now()
);

create table users (
  id text primary key,
  tenant_id text not null references institutions(id),
  display_name text not null,
  role text not null check (role in ('learner', 'teacher', 'scholar', 'admin', 'ops')),
  language text not null,
  created_at timestamptz not null default now()
);

create table canonical_ayahs (
  id text primary key,
  surah_number integer not null,
  ayah_number integer not null,
  text_uthmani text not null,
  source_id text not null check (source_id in ('quran-foundation', 'tanzil')),
  edition text not null,
  script_type text not null,
  import_version text not null,
  source_checksum text not null,
  unique (source_id, edition, surah_number, ayah_number)
);

create table canonical_words (
  id text primary key,
  ayah_id text not null references canonical_ayahs(id),
  word_index integer not null,
  text_uthmani text not null,
  source_checksum text not null,
  unique (ayah_id, word_index)
);

create table model_versions (
  id text primary key,
  kind text not null check (kind in ('alignment', 'tajweed', 'agent', 'planner')),
  version text not null,
  status text not null check (status in ('draft', 'eval-passed', 'released', 'blocked')),
  created_at timestamptz not null default now()
);

create table audit_events (
  id text primary key,
  tenant_id text not null references institutions(id),
  actor_id text not null references users(id),
  action text not null,
  subject_type text not null,
  subject_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table consent_records (
  id text primary key,
  tenant_id text not null references institutions(id),
  user_id text not null references users(id),
  audio_retention text not null check (audio_retention in ('discard', 'training-opt-in', 'teacher-review')),
  anonymized_learning boolean not null,
  external_asr_processing boolean not null default false,
  guardian_approved boolean not null default false,
  consent_version text not null default 'pilot-v1',
  effective_at timestamptz not null default now(),
  audit_event_id text not null references audit_events(id)
);

create table recitation_sessions (
  id text primary key,
  tenant_id text not null references institutions(id),
  learner_id text not null references users(id),
  quran_ref jsonb not null,
  source_checksum text not null,
  model_version_id text not null references model_versions(id),
  mode text not null default 'guided-recite' check (mode in ('listen', 'guided-recite', 'memory-recite', 'correction', 'drill', 'complete')),
  practice_plan_id text not null default 'fatihah-mastery-v1',
  external_processing_allowed boolean not null default false,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  review_status text not null,
  started_at timestamptz not null,
  latency_ms integer not null check (latency_ms >= 0),
  consent_record_id text not null references consent_records(id),
  audit_event_id text not null references audit_events(id)
);

create table realtime_session_tickets (
  id text primary key,
  tenant_id text not null references institutions(id),
  session_id text not null references recitation_sessions(id),
  learner_id text not null references users(id),
  token_hash text not null,
  expires_at timestamptz not null,
  allowed_sample_rates integer[] not null,
  external_asr_processing boolean not null,
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create table audio_chunks (
  id text primary key,
  tenant_id text not null references institutions(id),
  session_id text not null references recitation_sessions(id),
  evidence_id text not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms > start_ms),
  sample_rate integer not null check (sample_rate in (16000, 24000, 48000)),
  status text not null check (status in ('queued', 'streaming', 'aligned', 'review-needed')),
  object_key text,
  audit_event_id text not null references audit_events(id)
);

create table word_alignments (
  id text primary key,
  tenant_id text not null references institutions(id),
  session_id text not null references recitation_sessions(id),
  word_id text not null references canonical_words(id),
  heard_text text not null,
  start_ms integer not null,
  end_ms integer not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  status text not null check (status in ('matched', 'misread', 'missed', 'extra', 'needs-review')),
  model_version_id text not null references model_versions(id),
  audit_event_id text not null references audit_events(id)
);

create table alignment_runs (
  id text primary key,
  tenant_id text not null references institutions(id),
  session_id text not null references recitation_sessions(id),
  model_version_id text not null references model_versions(id),
  dataset_version text not null,
  latency_ms integer not null check (latency_ms >= 0),
  evidence_ids jsonb not null default '[]',
  consent_snapshot jsonb not null,
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create table tajweed_findings (
  id text primary key,
  tenant_id text not null references institutions(id),
  alignment_id text not null references word_alignments(id),
  rule text not null,
  severity text not null check (severity in ('practice', 'warning', 'critical')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  explanation text not null,
  review_status text not null,
  source_refs jsonb not null default '[]',
  model_version_id text not null references model_versions(id),
  audit_event_id text not null references audit_events(id)
);

create table teacher_reviews (
  id text primary key,
  tenant_id text not null references institutions(id),
  finding_id text not null references tajweed_findings(id),
  teacher_id text not null references users(id),
  decision text not null check (decision in ('accepted', 'rejected', 'edited')),
  note text not null,
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create table scholar_approvals (
  id text primary key,
  tenant_id text not null references institutions(id),
  topic text not null,
  reviewer_id text not null references users(id),
  status text not null check (status in ('draft', 'scholar-approved', 'blocked')),
  risk text not null check (risk in ('low', 'medium', 'high')),
  source_refs jsonb not null default '[]',
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create table agent_runs (
  id text primary key,
  tenant_id text not null references institutions(id),
  name text not null,
  goal text not null,
  status text not null check (status in ('queued', 'running', 'needs-human-review', 'approved', 'blocked')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  review_status text not null,
  source_refs jsonb not null default '[]',
  trace jsonb not null default '{}',
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create table eval_runs (
  id text primary key,
  tenant_id text not null references institutions(id),
  model_version_id text not null references model_versions(id),
  dataset_version text not null,
  metrics jsonb not null,
  word_alignment_f1 numeric not null default 0 check (word_alignment_f1 >= 0 and word_alignment_f1 <= 1),
  tajweed_f1 numeric not null default 0 check (tajweed_f1 >= 0 and tajweed_f1 <= 1),
  false_positive_rate numeric not null default 1 check (false_positive_rate >= 0 and false_positive_rate <= 1),
  teacher_agreement_rate numeric not null default 0 check (teacher_agreement_rate >= 0 and teacher_agreement_rate <= 1),
  unsourced_learner_outputs integer not null default 0 check (unsourced_learner_outputs >= 0),
  passed boolean not null,
  created_at timestamptz not null default now()
);

create table privacy_jobs (
  id text primary key,
  tenant_id text not null references institutions(id),
  learner_id text not null references users(id),
  kind text not null check (kind in ('export', 'delete')),
  included_records jsonb not null default '[]',
  deleted_records jsonb not null default '[]',
  audio_object_keys_deleted jsonb not null default '[]',
  audit_event_id text not null references audit_events(id),
  created_at timestamptz not null default now()
);

create index idx_users_tenant_role on users(tenant_id, role);
create index idx_sessions_tenant_learner on recitation_sessions(tenant_id, learner_id);
create index idx_realtime_tickets_tenant_session on realtime_session_tickets(tenant_id, session_id);
create index idx_alignment_runs_tenant_session on alignment_runs(tenant_id, session_id);
create index idx_findings_tenant_review on tajweed_findings(tenant_id, review_status);
create index idx_agent_runs_tenant_status on agent_runs(tenant_id, status);
create index idx_privacy_jobs_tenant_learner on privacy_jobs(tenant_id, learner_id);

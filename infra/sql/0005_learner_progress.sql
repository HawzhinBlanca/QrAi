-- Per-(tenant, learner, ayah) SM-2 spaced-repetition state. Drives real mastery,
-- streak, and next-review (replaces the hardcoded 0.0/0/null in get_progress).
create table if not exists learner_progress (
  tenant_id text not null references institutions(id),
  learner_id text not null references users(id),
  ayah_ref text not null,
  easiness_factor double precision not null default 2.5 check (easiness_factor >= 1.3),
  interval_days integer not null default 1 check (interval_days >= 0),
  repetitions integer not null default 0 check (repetitions >= 0),
  last_quality integer not null default 0 check (last_quality between 0 and 5),
  next_review_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, learner_id, ayah_ref)
);

create index if not exists idx_learner_progress_learner
  on learner_progress (tenant_id, learner_id);

-- 0011_teacher_review_required_status.sql
-- Promote teacher-review-required to a first-class blocked ReviewStatus and
-- constrain every persisted review_status column to the shared contract values.

update agent_runs
set review_status = 'scholar-approved'
where review_status = 'approved';

alter table recitation_sessions
  drop constraint if exists recitation_sessions_review_status_check;

alter table recitation_sessions
  add constraint recitation_sessions_review_status_check
  check (review_status in ('draft', 'ai-suggested', 'teacher-review-required', 'teacher-reviewed', 'scholar-approved', 'blocked'));

alter table tajweed_findings
  drop constraint if exists tajweed_findings_review_status_check;

alter table tajweed_findings
  add constraint tajweed_findings_review_status_check
  check (review_status in ('draft', 'ai-suggested', 'teacher-review-required', 'teacher-reviewed', 'scholar-approved', 'blocked'));

alter table agent_runs
  drop constraint if exists agent_runs_review_status_check;

alter table agent_runs
  add constraint agent_runs_review_status_check
  check (review_status in ('draft', 'ai-suggested', 'teacher-review-required', 'teacher-reviewed', 'scholar-approved', 'blocked'));

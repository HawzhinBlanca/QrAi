-- 0010_review_status_check.sql
-- recitation_sessions.review_status was free text; constrain it to the known ReviewStatus
-- values so bad data can't be persisted (matches ReviewStatus in the platform-api types).

alter table recitation_sessions
  drop constraint if exists recitation_sessions_review_status_check;

alter table recitation_sessions
  add constraint recitation_sessions_review_status_check
  check (review_status in ('draft', 'ai-suggested', 'teacher-reviewed', 'scholar-approved', 'blocked'));

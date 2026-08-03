-- A teacher's review outlives the finding it was about.
--
-- `persist_session_alignments` replaces a session's alignment on write, and because
-- `tajweed_findings.alignment_id` and `teacher_reviews.finding_id` both RESTRICT, it cascades:
-- teacher_reviews -> tajweed_findings -> word_alignments. The route is authorised for the session
-- OWNER, so a learner re-recording their own session DELETED any review a teacher had already
-- submitted on it. The audit event records that it happened; the review itself was gone.
--
-- Invalidating the FINDING on re-recording is correct and is not changed here — the finding points
-- at words that no longer exist. But a teacher's judgement is a professional record about a named
-- learner, made by a named person at a known time, and a learner action should not be able to erase
-- it. Whether re-recording should be allowed to invalidate a review at all is a product question;
-- keeping the record of one having been made is not.
--
-- Two changes make that possible:
--
--   finding_id becomes NULLABLE  so the cascade can DETACH the review instead of deleting it.
--   reviewed_finding             a snapshot of what the teacher was looking at. Without it a
--                                detached review says "a teacher rejected something" — the sentence
--                                stops being evidence at the point it matters most.
--
-- `superseded_at` is what a detached review is: not withdrawn, not wrong — about something the
-- learner has since replaced.
alter table teacher_reviews
  alter column finding_id drop not null;

alter table teacher_reviews
  add column if not exists reviewed_finding jsonb not null default '{}',
  add column if not exists superseded_at timestamptz;

-- NO CHECK CONSTRAINT enforcing "a detached review carries a snapshot", though the first draft of
-- this migration had one. It was written as
--
--   check (finding_id is not null or reviewed_finding <> '{}' or superseded_at is null)
--
-- and a mutation test found what it actually does. Reviews written BEFORE this migration have
-- `reviewed_finding = '{}'` — their snapshot was never captured and inventing one now would be
-- fabricating evidence. Detaching such a row sets finding_id NULL and superseded_at, failing all
-- three arms, so the constraint fires and the learner's ordinary re-record returns 500. A rule that
-- turns old data into an outage on a routine action is worse than no rule.
--
-- The invariant is held where it can be held honestly: create_teacher_review captures the snapshot
-- in the same read that validates the finding, so every review written from now on has one, and a
-- test asserts it. Legacy rows stay identifiable by `reviewed_finding = '{}'` — which is the truth
-- about them: a decision whose subject was not recorded.

-- The queue reads live reviews; a detached one is history.
create index if not exists idx_teacher_reviews_superseded
  on teacher_reviews(tenant_id, superseded_at);

-- An alignment must identify a real stretch of audio.
--
-- `word_alignments.start_ms`/`end_ms` are the ONLY record of WHERE in a recitation a word was heard,
-- and a `tajweed_findings` row is anchored to the alignment. So a finding whose span is 0ms to 0ms
-- points at nothing: a reviewer asked to adjudicate it — the purpose of the review queue, and the
-- precondition for ever assembling an adjudicated corpus — has nothing to listen to, and the row is
-- indistinguishable in the table from one pointing at real audio.
--
-- This table already constrained `confidence` (0..1), `status` and `transcript_source`. The span,
-- which is the part that makes a finding evidence at all, accepted anything an int4 could hold.
--
-- ── Why a constraint when both services already check ────────────────────────────────────────────
-- `usable_span` (handlers/recitation.rs) and `usableSpan` (routes/session-writes.mjs) refuse an
-- unusable span at the API. Two implementations of one rule, and two implementations agreeing proves
-- nothing about a third: a backfill, a fixture script, a migration, a psql session at 3am, or the
-- next port. The constraint is the only place the rule holds regardless of who is writing — the same
-- argument as 0010/0011 for review_status, where the services believed one thing and the table
-- enforced another.
--
-- ── NOT VALID, deliberately, and it still enforces ───────────────────────────────────────────────
-- Measured on staging when this was written: 5618 alignment rows, of which 238 violate — 232
-- zero-length, 4 inverted, 2 with a negative start — carrying 507 tajweed findings between them.
-- Those rows are the reason this constraint exists; they are also why it cannot be added VALIDATED.
--
-- NOT VALID skips the initial full-table scan ONLY. Postgres enforces the constraint on every
-- INSERT and UPDATE from the moment it is added, which is the whole point: no new row can be
-- written that identifies no audio. The back catalogue is a separate decision — cleaning it changes
-- what a reviewer sees for findings a teacher may already have acted on — and is recorded rather
-- than done here.
--
-- To adopt the existing rows later, once they have been triaged:
--   alter table word_alignments validate constraint word_alignments_span_identifies_audio;
-- That takes a SHARE UPDATE EXCLUSIVE lock (concurrent reads and writes continue) and fails loudly
-- if any row still violates, which is the right way round.
--
-- ── The rule ─────────────────────────────────────────────────────────────────────────────────────
--   start_ms >= 0   a position in a recording cannot be negative
--   end_ms > start_ms   a word takes time to say; zero-length is the absence of a measurement
--                       recorded as a measurement, which is the case that produced all 232 rows
-- The int4 upper bound is the column type, so it needs no clause here.
--
-- A DO block because `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS`, and every other
-- migration in this directory is re-runnable. Without the guard, applying this file twice is an
-- error, and the CI apply list runs unconditionally.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'word_alignments'::regclass
      and conname = 'word_alignments_span_identifies_audio'
  ) then
    alter table word_alignments
      add constraint word_alignments_span_identifies_audio
      check (start_ms >= 0 and end_ms > start_ms)
      not valid;
  end if;
end $$;

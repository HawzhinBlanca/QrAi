-- 0022_session_lost_chunks.sql
--
-- A session can be INCOMPLETE without anything on the session saying so.
--
-- When a chunk is accepted by the gateway and never reaches storage — an ML outage, a crashed
-- writer, a bad disk — the audio is simply absent. Transcription assembles what is there and the
-- aligner scores that short transcript against the FULL canonical passage, so words the learner DID
-- recite are recorded as words they missed. Measured end to end in
-- specs/dr-rehearsal/evidence/P5.4-partial-loss-recovery.log.
--
-- Until now the only trace was `realtime_gateway_chunks_forward_failed_total`, a PROCESS counter:
-- it says some chunks were lost somewhere, for someone. An operator could see it. The learner, the
-- teacher, and every downstream consumer could not, and nothing could decline to score a session it
-- had no way of knowing was incomplete.
--
-- This column records it ON THE SESSION. It deliberately does NOT change scoring or block review —
-- what SHOULD happen to a gapped session (refuse to score / mark provisional / show it in review)
-- is a product decision. This makes that decision possible by making the fact available.
--
-- DEFAULT 0 is truthful for existing rows: no gap was detected, because nothing was looking.

alter table recitation_sessions
  add column if not exists lost_chunk_count integer not null default 0
    check (lost_chunk_count >= 0);

comment on column recitation_sessions.lost_chunk_count is
  'Chunks accepted upstream but missing from storage at finalize. Interior gaps only — loss off the '
  'end of a session is not detectable without a declared chunk total. Recorded, not acted on.';

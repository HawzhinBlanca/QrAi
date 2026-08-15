-- Where the words in a word_alignments row came from.
--
-- Two paths write this table and until now they were indistinguishable once written:
--
--   server-derived   finalize_session fetches the transcript server-to-server from the service
--                    holding the audio. The caller names a session and nothing else.
--   client-reported  the web client posts alignments it computed from a transcript IT supplied —
--                    either /v1/asr/transcribe round-tripped through the browser, or the browser's
--                    own Web Speech API. A client can also skip the audio entirely and post a
--                    flawless recitation.
--
-- Both were counted the same by /v1/learner/progress/weekly, which called the result "accuracy",
-- and a teacher reviewing a finding had no way to tell which kind of evidence it rested on.
--
-- DEFAULT 'client-reported', deliberately. Every existing row predates this column and every one of
-- them came from the web path, so the default has to be the weaker claim. A default of
-- 'server-derived' would silently promote the entire back catalogue to measured evidence — which is
-- the exact failure this column exists to prevent.
alter table word_alignments
  add column if not exists transcript_source text not null default 'client-reported'
    check (transcript_source in ('server-derived', 'client-reported'));

-- The weekly-progress query filters on it per learner-day, alongside the session join.
create index if not exists idx_word_alignments_session_source
  on word_alignments(session_id, transcript_source);

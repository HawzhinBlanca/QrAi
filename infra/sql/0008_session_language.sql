-- 0008_session_language.sql
-- recitation_sessions accepted a `language` from the client and echoed it on create,
-- but never stored it — so get_session hard-coded "ar" on retrieval, reporting Arabic
-- for every session regardless of the learner's actual language. Add the column so the
-- request-to-storage-to-retrieval path is real.

alter table recitation_sessions
  add column if not exists language text not null default 'ar';

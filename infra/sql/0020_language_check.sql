-- users.language and recitation_sessions.language were plain unvalidated text, unlike every
-- other enum-shaped column in this schema (role, review_status, status, severity, risk,
-- audio_retention), which all have a CHECK constraint. Constrain both to the known
-- SUPPORTED_LANGUAGE_CODES list (packages/contracts/src/index.ts / platform-api's
-- SUPPORTED_LANGUAGE_CODES in types.rs) so bad data can't be persisted even if a future
-- caller bypasses the Rust-side is_supported_language() check.
alter table users
  drop constraint if exists users_language_check;

alter table users
  add constraint users_language_check
  check (language in ('ar', 'ckb', 'en', 'tr', 'ur', 'id', 'ms', 'fr', 'de'));

alter table recitation_sessions
  drop constraint if exists recitation_sessions_language_check;

alter table recitation_sessions
  add constraint recitation_sessions_language_check
  check (language in ('ar', 'ckb', 'en', 'tr', 'ur', 'id', 'ms', 'fr', 'de'));

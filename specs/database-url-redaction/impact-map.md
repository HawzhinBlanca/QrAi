# Database URL Redaction Impact Map

## Files

- `services/platform-api/src/main.rs`
  - Adds a small URL redaction helper and uses it in the Postgres connection error log.
  - Adds unit tests for password-in-authority, password query parameter, and passwordless URLs.

## Affected Callers

- Platform API startup remains unchanged except for redacted error text.
- No API routes or database query behavior changes.

## Proof

- Red target: a unit test expecting `postgresql://user:***@host/db` fails before the helper is wired.
- Green target: platform-api tests pass under `bash scripts/verify.sh`.

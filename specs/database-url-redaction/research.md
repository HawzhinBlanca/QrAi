# Database URL Redaction Research

## Current Behavior

- `services/platform-api/src/main.rs` logs `Failed to connect to Postgres at {database_url}: {e}` when pool connection fails.
- `DATABASE_URL` commonly contains credentials, for example `postgresql://user:password@host/db`.
- The existing secret guard prevents tracked secret files, but it does not stop runtime logs from printing credential-bearing URLs.

## Risk

A failed production database connection can write database credentials into process logs. Logs are often centralized and visible to broader operational systems than the secret store.

## Target Behavior

- Startup failure logs redact URL passwords before printing.
- URLs without passwords remain useful for debugging.
- Query-string `password=` parameters are also redacted.
- `bash scripts/verify.sh` proves the helper with Rust unit tests.

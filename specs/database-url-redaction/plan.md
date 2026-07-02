# Database URL Redaction Plan

Approved-by: user directive, "do all and continue"

1. Add a failing Rust test first.
   - Assert authority passwords are redacted.
   - Assert query-string `password=` values are redacted.
   - Assert passwordless URLs are unchanged.

2. Implement redaction.
   - Keep the helper local to `services/platform-api/src/main.rs`.
   - Use it only in the startup connection failure message.

3. Verify and commit.
   - `cargo test --manifest-path services/platform-api/Cargo.toml`
   - `bash scripts/verify.sh`

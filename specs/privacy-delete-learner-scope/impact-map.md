# Privacy Delete Learner Scope Impact Map

## Changed Symbols

- `create_privacy_job` in `services/platform-api/src/handlers/privacy.rs`
  - Narrows teacher review, tajweed finding, word alignment, audio chunk, and alignment run deletes to sessions matching both `tenant_id` and `learner_id`.
  - Keeps existing learner progress, realtime ticket, session, and consent deletes scoped by tenant and learner.

- `privacy_delete_preserves_other_learners_teacher_reviews` in `services/platform-api/tests/integration.rs`
  - Seeds two same-tenant learners with reviewed findings.
  - Deletes the target learner through `/v1/privacy/delete`.
  - Asserts the other learner's session, finding, and review remain.

## Test Coverage

- `cargo test --manifest-path services/platform-api/Cargo.toml privacy_delete_preserves_other_learners_teacher_reviews -- --ignored`
- `cargo test --manifest-path services/platform-api/Cargo.toml`
- `bash scripts/verify.sh`

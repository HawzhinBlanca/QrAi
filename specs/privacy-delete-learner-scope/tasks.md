# Privacy Delete Learner Scope Tasks

- [x] T1 Scope privacy delete cascades to the requested learner's sessions. Tests: `cargo test --manifest-path services/platform-api/Cargo.toml privacy_delete_preserves_other_learners_teacher_reviews -- --ignored`, `cargo test --manifest-path services/platform-api/Cargo.toml`, `bash scripts/verify.sh`

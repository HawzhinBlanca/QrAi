# Review Status Contract Research

## Current Behavior

- `services/ml-inference/server.mjs` returns `reviewStatus: "teacher-review-required"` when confidence or consent does not allow automatic learner-facing feedback.
- `scripts/smoke-ml.mjs` and `scripts/smoke-privacy.mjs` assert that this status is returned.
- `packages/contracts/src/index.ts` does not include `teacher-review-required` in `ReviewStatus`.
- `services/platform-api/src/types.rs` does not include the status in the Rust enum.
- `infra/sql/0010_review_status_check.sql` constrains persisted recitation session statuses to the older set.

## Risk

The ML/privacy path uses a legitimate gate status that is not part of the shared contract or persisted status constraint. That makes generated clients, Rust DTOs, and database writes disagree about a safety-critical state.

## Target Behavior

- `teacher-review-required` is a first-class `ReviewStatus`.
- Learner-facing AI gates block it the same way they block `draft`, `ai-suggested`, and `blocked`.
- Rust serde accepts and emits it.
- SQL constraints allow it where review status is persisted.
- SQL smoke and compose initialization apply the status constraint migration.

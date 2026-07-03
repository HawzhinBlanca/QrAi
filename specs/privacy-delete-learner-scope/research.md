# Privacy Delete Learner Scope Research

## Target Surface

- `services/platform-api/src/handlers/privacy.rs`
  - `create_privacy_job` performs export/delete for a requested learner.
  - Delete mode removes learner progress, reviews, findings, alignments, audio chunks, alignment runs, realtime tickets, sessions, and consent records.
- `services/platform-api/tests/integration.rs`
  - Existing live-Postgres tests cover privacy-adjacent cascade behavior for re-recorded alignments, but not cross-learner preservation during privacy delete.

## Finding

The privacy delete path deleted `teacher_reviews` with only a tenant filter:

`DELETE FROM teacher_reviews WHERE tenant_id = $1 AND finding_id IN (SELECT id FROM tajweed_findings WHERE tenant_id = $1)`

That removes every teacher review for the tenant, not only reviews attached to the requested learner's sessions. Some later deletes also selected sessions by `learner_id` without repeating the tenant filter inside the subquery.

## Acceptance Criteria

- WHEN an admin deletes learner A's privacy data, THE platform API SHALL delete reviews/findings/alignments only for learner A's tenant-scoped sessions.
- WHEN learner B has a reviewed finding in the same tenant, THE platform API SHALL preserve learner B's session, finding, and teacher review.
- WHEN the live Postgres integration tests run, THE regression SHALL fail on tenant-wide review deletion and pass only with learner-scoped delete predicates.

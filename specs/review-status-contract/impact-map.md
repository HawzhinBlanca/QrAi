# Review Status Contract Impact Map

## Symbols

- `ReviewStatus` in `packages/contracts/src/index.ts`
  - Affected callers: TypeScript platform records, web data types, contract gate tests.

- `canShowLearnerFacingAiOutput`
  - Affected callers: web platform helpers, agent gate mirror, contract tests.

- `ReviewStatus` in `services/platform-api/src/types.rs`
  - Affected callers: recitation session serialization/deserialization.

- `row_to_session` in `services/platform-api/src/handlers/recitation.rs`
  - Affected callers: session fetch/list responses from Postgres.

- `recitation_sessions_review_status_check`
  - Affected callers: migrations, live SQL smoke, docker-compose initialized DBs.

## Tests

- Contract test for blocking `teacher-review-required`.
- Agents test for the mirrored block.
- SQL smoke applies the widened check during live setup.

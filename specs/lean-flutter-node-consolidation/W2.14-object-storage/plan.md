# W2.14 plan — private retained-audio object lifecycle

**Status:** IMPLEMENTED AND LOCALLY VERIFIED; ledger remains open pending required remote CI<br>
**Criterion:** BE-6<br>
**Primary proof:** `tests/e2e/audio-lifecycle.test.mjs`

1. Add failing lifecycle/config tests for server-derived keys, filesystem create-only retries,
   S3 protocol headers/pagination/partial-delete errors, deadline cancellation, tenant prefixes,
   privacy export/delete, review read, and reconciliation.
2. Add exact `@aws-sdk/client-s3` 3.1101 to the server production boundary and record the runtime
   dependency implementation decision in ADR-0050.
3. Implement one async object-store interface with strict environment parsing, filesystem and S3
   adapters, bounded byte/metadata validation, checksums, create-only writes, full pagination,
   idempotent deletion, readiness, and close.
4. Replace transitional ML filesystem primitives with the shared interface for chunk storage,
   playback, learner/session listing, privacy, transcript assembly, and retention sweep; preserve
   declared legacy filesystem reads during migration.
5. Inject the same interface into Node API composition. Use it directly for review playback and
   privacy export/delete; retain the ML HTTP path only as an explicit compatibility fallback until
   W2.17.
6. Derive audio index keys from ticket/session/learner/chunk authority in Node and Rust oracle paths;
   update the internal OpenAPI description and gateway body without trusting supplied object keys.
7. Generalize the repair command into dry-run-first storage reconciliation, preserve the old command
   alias, and prove tenant/session ownership before any database repair.
8. Update image/Compose configuration, backup/data inventory, architecture, decisions, testing,
   operations, threat model, and canonical test registration.
9. Run focused hermetic/live tests, dependency audit/licence checks, builds, `git diff --check`, and
   the exact `bash scripts/verify.sh` gate. Keep the ledger unchecked until remote CI is green.

## Completion checks

- No production-shaped boot silently uses filesystem storage.
- No caller controls an object key, tenant prefix, retention, or ownership decision.
- Same retry is a no-op; conflicting bytes are refused; incomplete effects are reconcilable.
- Export lists all learner audio; delete is fully paginated, verified, auditable, and retry-safe.
- Teacher playback remains role/tenant/consent gated and is marked served only after full validation.

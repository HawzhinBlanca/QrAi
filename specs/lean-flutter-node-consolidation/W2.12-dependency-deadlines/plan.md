# W2.12 plan — bounded dependency work

Umbrella W0–W7 implementation approval covers this task. Work remains one ledger item and is not
marked done until the canonical gate and required remote CI are green.

## Implementation sequence

1. Add a dependency-free monotonic deadline/abort helper with strict timeout validation, parent
   signal composition, and a fetch wrapper that covers response-body consumption.
2. Create one API request deadline before local work; propagate it through compatibility proxying,
   ML/ASR routes, finalization, privacy erase, review audio, and request-scoped database facades.
3. Add PostgreSQL server-side statement timeouts globally and tighten tenant transactions to the
   request remainder. Map timeout SQLSTATEs to a fixed retryable response and prove transaction
   rollback rather than racing the driver promise.
4. Propagate the same budget through ML→ASR transcription, forced alignment, acoustic windows, and
   through every agent batch/platform call. Add strict service startup timeout validation and
   generic timeout errors.
5. Make review-audio audit state explicit: eligibility/attempt is durable before storage access;
   `served` is written only after the complete response validates.
6. Add `tests/faults/dependency-timeouts.test.mjs` covering hung compatibility, ASR, storage/privacy,
   worker, and Postgres rollback/partial-state behavior. Add hermetic helper/boot guards where they
   sharpen failure diagnosis.
7. Register every proof exactly once in `scripts/verify.sh` and assert the invocation. Update the
   architecture, decisions, testing, runbook, and threat-model docs.
8. Run focused hermetic/live tests, direct and through-Node parity, build/image checks as affected,
   then the exact canonical `bash scripts/verify.sh` command with the restricted database.

## Acceptance mapping

| EARS criterion | Automated proof |
|---|---|
| IF compatibility Rust hangs, THEN THE API SHALL return a bounded retryable response and abort the upstream request. | `dependency-timeouts.test.mjs` compatibility case |
| IF ASR hangs during ML inference, THEN THE ML operation SHALL consume one bounded deadline and SHALL not report inference completion. | ASR/ML hung-process case |
| IF object storage hangs during privacy erase or review audio, THEN THE API SHALL cancel the read/delete and SHALL not claim delete/playback completion. | storage privacy/review cases plus persisted-state assertions |
| IF Postgres exceeds the request budget inside a write transaction, THEN PostgreSQL SHALL cancel it, THE API SHALL return retryable 503, and THE transaction SHALL roll back. | live `pg_sleep` rollback case |
| IF the agent worker's platform dependency hangs, THEN THE worker SHALL cancel it and return a bounded generic retryable response. | worker hung-process case |

## Verification boundary

Focused proof must pass both without and with the live restricted database. The canonical command is:

```sh
set -a
source scripts/stack.env
set +a
MIGRATION_TEST_ADMIN_URL='postgresql://hawzhin@127.0.0.1:5433/postgres' bash scripts/verify.sh
```

# W2.8 plan — learner-owned recitation history

**Status:** approved under the repository owner's W0–W7 consolidation approval and ADR-0038<br>
**Architecture change:** none beyond the already accepted learner-history target addition

## EARS acceptance criteria

1. WHEN an authenticated learner requests history without a cursor, THE Node API SHALL return only
   that learner's tenant-scoped sessions in descending `(started_at,id)` order, at most 20 by
   default. Test: learner-history E2E own-only first page.
2. WHEN a valid owned cursor and limit are supplied, THE Node API SHALL return the next stable page
   without duplicates and SHALL expose a next cursor only when another row exists. Test: three-page
   keyset pagination plus concurrent-newer-session control.
3. IF a cursor names an unknown, other-owner, or cross-tenant session, THEN THE Node API SHALL return
   404 without confirming the session exists. Test: cursor isolation matrix.
4. IF `limit` is malformed or outside `[1,50]`, THEN THE Node API SHALL return 400 and SHALL execute
   no unbounded list. Test: hostile limit vectors.
5. WHEN teacher review changes an acoustic finding after practice, THE next learner history refresh
   SHALL reflect pending/reviewed/blocked counts without rerunning inference, while detailed content
   remains governed by the session-finding redaction route. Test: delayed-review E2E.
6. WHEN staff call the new learner path or a learner calls the staff list, THE API SHALL return 403;
   the existing staff listing allowlist SHALL remain unchanged. Test: absolute role assertions.
7. WHEN the target addition becomes active, THE contract SHALL preserve the exact 42-operation Rust
   baseline and derive the 43-operation transition set as baseline plus implemented additions. Test:
   OpenAPI/manifest arithmetic and route registry guards.

## Implementation tasks

1. Red: change the contract tests to require the implemented learner-history addition and add the
   live E2E forced to the missing local route. Observe contract and unportable-route failures.
2. Add strict cursor/limit parsing and `listLearnerSessionHistory` in the existing session route
   module. Use one tenant transaction, an ownership-scoped cursor lookup, keyset SQL, acoustic state
   counts, exact timestamp formatting, and no learner judgement fields.
3. Register the route in `ROUTES` and `PORTABLE`; move mechanical inventory guards 40 → 41.
4. Add the manifest/OpenAPI operation and strict page/item schemas. Preserve baseline/target set
   arithmetic and mark only this addition implemented.
5. Add the E2E once to the DB-gated canonical verification sequence. Do not run it on the Rust-only
   oracle leg because the endpoint is deliberately a Node target addition.
6. Run focused contract, lifecycle, role, pagination, delayed-review, no-secret, and package-build
   tests; then the full live canonical gate.
7. Build and run the production image as uid 1000, probe health/readiness, import 41 routes, and
   assert no legacy Node or Rust API tree is present. Record evidence without checking the ledger
   until remote CI is green.

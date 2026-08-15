# W2.7 research — local learner session finding retrieval

## Scope and method

- Goal: port `GET /v1/recitation-sessions/{id}/tajweed-findings` into the existing Node review
  module, completing the third retained Rust-only operation without creating another service or
  route structure.
- Serena mapped the Node review helpers, staff finding handler, route registry, and every Node
  reference. The active Serena language server does not index Rust or Dart in this workspace, so
  the Rust handler/tests and Flutter caller were inspected read-only by exact file and line range.
- Reviewed the Rust oracle, RLS query, learner gate, OpenAPI schema, Flutter immediate-feedback
  call flow, parity coverage ledger, route-count guards, and the live fixture/cleanup harness.

## Current call and data flow

1. Flutter `PracticeScreen` finalizes a session, asks the ML route for fresh analysis, then calls
   `ApiClient.listSessionTajweedFindings` for the stored rows. Stored rows win when present because
   only they can carry later teacher decisions back to the learner.
2. Rust authenticates, starts a tenant-scoped transaction, selects the session owner, returns 404
   for a missing/invisible session, then applies one owner/staff predicate.
3. The exact staff set is teacher/admin/ops. A learner reads only their own session; a scholar is
   not staff on this learner-performance route; cross-tenant sessions are hidden by RLS/404.
4. The query returns only acoustic findings anchored through the session's word alignments. It also
   derives audio availability and exact evaluation/calibration/provenance fields used by the shared
   learner-feedback gate.
5. Every row is returned so the client can distinguish “waiting for a teacher” from “no feedback”.
   When a row does not clear the full gate, a learner receives its existence/review state but no
   judgement: word, rule, severity, explanation, confidence, and sources are redacted.
6. Staff receive the same stored row intact so they can review it. `withheld` has one meaning for
   both audiences: the row is not learner-visible.

## Existing Node boundary and gap

- `server/src/routes/review.mjs` already owns the only relevant policy helpers:
  `audioStatus`, `evaluationEvidenceStatus`, `storedFindingGateInput`, and
  `clearsLearnerFeedbackGate`. Reimplementing any of them would create two security opinions.
- `listTajweedFindings` already proves the SQL joins, f64 wire encoding, source-key sorting, audio
  status, evaluation matching, and acoustic-only filter. The session route needs a narrower
  ownership predicate and response projection, not a new repository/domain layer.
- The Rust route and OpenAPI operation already exist, Flutter already calls it, and four Rust
  behaviors are already represented in `tests/api-parity/db-endpoints.test.mjs`. Today those tests
  can only reach Rust because the route is absent from Node `ROUTES`/`PORTABLE`.
- The production route inventory is 39 of the 42 baseline operations. Adding this route makes 40;
  it does not change the 42-operation contract or add an OpenAPI operation.
- Current production trust is deliberately empty: `storedFindingGateInput` reports uncalibrated
  evidence and no row becomes release-trusted. Human review alone therefore cannot un-withhold a
  fixture or incomplete evidence chain. The port must preserve this fail-closed state.

## Implementation discovery

- Red/green work exposed a policy/wire type defect in the shared stored-row helper: it passed the
  `RustF64` serialization wrapper into `clearsLearnerFeedbackGate`, whose contract correctly requires
  an ordinary JavaScript number. That kept today's incomplete evidence fail-closed, but would also
  have withheld a future release-trusted row for the wrong reason.
- The helper now uses `Number(row.confidence)` for policy evaluation and applies `f64(...)` only when
  constructing the HTTP response. `learner-feedback-gate.test.mjs` pins that separation so a wire
  compatibility helper cannot silently become a policy value again.
- The live authorization database contains no permanent recitation-session seed. The absolute role
  matrix therefore creates and removes a declared learner-owned fixture through the Rust oracle;
  this reaches the 403 ownership gate deterministically instead of accepting a vacuous 404.

## Decision

- Add one `listSessionTajweedFindings` handler to the existing `review.mjs`; do not add a new module,
  service, database view, migration, or response model.
- Import and use `requireSelfOrAny`; define the teacher/admin/ops array once in the handler and use
  the same array for authorization and the redaction decision.
- Run the session lookup and finding read inside one `ctx.db.withTenant` transaction. Preserve 404
  before ownership, acoustic-only filtering, confidence/id ordering, and exact Rust f64/key shape.
- Reuse `storedFindingGateInput` and `clearsLearnerFeedbackGate`. Redact only for a non-staff caller
  when withheld; use `f64(0)` plus empty judgement/source fields so the redacted row fails the
  client gate even if a client ignores `withheld`.
- Extend the existing `db-endpoints` suite rather than adding another overlapping test structure.
  Force this route local when the suite runs through the Node shell and add staff-intact and scholar
  refusal assertions beside the existing owner/redaction/fresh-session/other-owner/404 cases. Add
  exact response-byte comparisons for the learner and staff projections.
- Register the route in the single route table and literal portable allowlist, update mechanical
  39→40 guards, run the source-built non-root image probe, then the full live canonical gate.

## Callers and proof obligations

- Runtime callers: Flutter `ApiClient.listSessionTajweedFindings` and `PracticeScreen._loadFindings`;
  the teacher-review promotion path; session/alignment/finding tables; Node route composition and
  startup allowlist.
- Assurance callers: `db-endpoints.test.mjs`, parity coverage ledger, through-Node canonical pass,
  route-table/relocation counts, production-image import probe, OpenAPI/Flutter contract tests.
- Red first: force the missing route local and move registry expectations 39→40. The shell must
  refuse the unportable key before implementation.
- Required live outcomes: own learner 200; other learner 403; scholar 403; teacher/admin/ops intact;
  unknown and cross-tenant 404; withheld judgement fields empty with confidence `0.0` and no
  sources; fresh sessions empty; exact stable order; no instructional text-rule rows.
- Remote CI remains required before W2.7 can be checked done; local `VERIFY OK` and an image probe
  are engineering evidence, not deployment or release evidence.

# W2.8 research — learner-owned recitation history

## Scope and approved boundary

- ADR-0038 already approves `GET /v1/learner/recitation-sessions` as the learner-history target
  addition. W2.8 implements that one operation; it does not add identity, login, a Flutter screen,
  a migration, or another service.
- The existing `GET /v1/recitation-sessions` remains the tenant-wide teacher/admin/ops listing.
  Relaxing it for learners would expose other learners and violate the explicit ADR boundary.
- The endpoint exists so a learner can refresh after a teacher acts later or from another device.
  W4.9 will build the Flutter inbox; W2.8 provides and proves the backend contract first.

## Repository map

- Serena mapped `server/src/routes/sessions.mjs::{listSessions,getSession}` and the route registry.
  `listSessions` is referenced only by the registry, is capped at 50, and intentionally rejects a
  learner. `ROUTES` is consumed by `createApplication`; `PORTABLE` is also a literal startup and
  cutover assurance surface until W2.9 removes that duplication.
- The active Serena language server indexes TypeScript/JavaScript but not Dart, Rust, YAML, or SQL.
  Those surfaces were inspected read-only: ADR-0038, the route manifest/OpenAPI, the Flutter API
  client/models, the Rust session/review behavior, migrations, and live-test harnesses.
- Flutter currently creates a `RecitationSession` and retrieves one session's findings immediately.
  It has no history call or inbox. `createTeacherReview` updates the finding review status, not the
  parent session status, so a useful history row needs finding-state counts rather than relying on
  `recitation_sessions.review_status` alone.
- W2.7 already owns the only learner-facing finding projection and complete evidence gate. History
  must not copy judgements, confidence, explanations, sources, or a second visibility decision.

## Contract and pagination findings

- The immutable runtime baseline remains 42 Rust operations. During transition, adding the first
  implemented target addition makes the active OpenAPI contract 43 operations: 42 baseline plus one
  implemented addition. The final target remains 42: 38 retained baseline plus four additions after
  four retirements. Tests must derive these sets instead of changing the baseline count.
- Offset pagination can duplicate or skip sessions when a new practice is inserted between page
  requests. Use keyset pagination ordered by `(started_at DESC, id DESC)`.
- Use the last session id as the cursor. The server resolves it inside the authenticated learner's
  tenant/ownership scope, then applies its exact `(started_at,id)` boundary. An unknown, same-tenant
  other-owner, or cross-tenant cursor is 404 and reveals no existence.
- `limit` is optional, defaults to 20, and is a strict decimal integer in `[1,50]`. Repeated,
  signed, spaced, fractional, zero, or oversized values are 400; they are never coerced.
- Fetch `limit + 1`, return at most `limit`, and set `nextCursor` to the last returned id only when
  another row exists. This is stable under concurrent insertion of newer sessions.

## Lean response decision

Return `{items,nextCursor}`. Each item contains only:

- `id`, `quranRef`, `mode`, `reviewStatus`, and microsecond-preserving `startedAt`;
- acoustic-only `findingCount`, `pendingFindingCount`, `reviewedFindingCount`, and
  `blockedFindingCount`.

Pending means `draft`, `ai-suggested`, or `teacher-review-required`; reviewed means
`teacher-reviewed` or `scholar-approved`; blocked means `blocked`. The four counts are metadata,
not learner-performance judgements. The inbox can show honest pending/reviewed/blocked state and
then call the existing per-session findings route, which still redacts any row that fails the full
audio/calibration/evaluation/source gate. Instructional text-rule annotations are excluded.

## Callers and proof obligations

- Runtime: `sessions.mjs`, `routes/index.mjs`, `main.mjs`, database RLS/session/alignment/finding
  tables, future Flutter W4.9 caller.
- Contract: route manifest implementation status, OpenAPI path/page/item schemas, active-contract
  set arithmetic, response validator, future generated Dart client.
- Assurance: route counts 40 → 41, source-built image import, explicit canonical-gate invocation,
  own-only role tests, cursor isolation, strict limit tests, deterministic no-duplicate pages, and
  delayed teacher-review refresh without repeating inference.
- The live E2E must create declared fixtures, change a finding through the real teacher-review API,
  observe pending → reviewed counts through the learner endpoint, retrieve the session's findings,
  and remove every temporary row.
- Remote CI remains the task-completion boundary. Local `VERIFY OK` and image proof are engineering
  evidence, not a deployment claim.

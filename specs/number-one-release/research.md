# Research: Number-One Release Program

## Decision

QrAi cannot be called launch-ready from a green local build alone. The current
release evidence has three material gaps: it is not tied to a clean immutable
candidate; platform-api's live-Postgres integration suite can be skipped; and
the learner's core recitation journey has not been freshly proven against the
full stack. Quranic correctness, privacy, and tenant isolation are release
invariants rather than quality improvements.

## Verified starting point

- `scripts/verify.sh` is the canonical local/CI gate, but deliberately skips
  the 47 ignored platform-api integration tests when Postgres is unavailable.
- `scripts/smoke-all.mjs` is the aggregate runtime harness: proof, SQL,
  browser, API, gateway, ML, and privacy all share a trace identifier.
- Learner AI output is contract-gated on review/approval/source status.
- The Tajweed engine deliberately withholds mushaddad ghunnah pending a
  qualified scholar's sign-off; the neural model is experimental and remains
  off the learner path.
- The mobile app's native UI path has not been proven on real devices.
- The UI has automated accessibility coverage, but no completed keyboard,
  screen-reader, or RTL human validation.
- Non-English language selection currently falls back to English; it must not
  be advertised as localized until native-speaker-reviewed resources exist.

## Release truth model

Every claim must identify: (1) immutable commit SHA, (2) environment, (3)
actor/tenant, (4) generated artifact, and (5) an independent verifier. A test
passing only in a developer's working tree is evidence, not a release claim.

## Existing relevant surfaces

- Runtime orchestration: `scripts/verify.sh`, `scripts/smoke-all.mjs`,
  `scripts/smoke-{api,sql,browser,ml,privacy,gateway}.mjs`.
- Web journey: `apps/web/src/App.tsx`, `LearnerHome.tsx`, `PracticeFlow.tsx`,
  `PrivacySettings.tsx`, and `TeacherSurface.tsx`.
- Domain gates: `packages/contracts/src/index.ts`,
  `services/ml-inference/tajweed.js`, and `docs/SCHOLAR_REVIEW.md`.
- Persistence/tenant boundary: `infra/sql/0003_tenant_rls.sql`,
  `services/platform-api/tests/integration.rs`, and platform-api handlers.
- Production packaging: `docker-compose.yml`, Dockerfiles, nginx config, and
  protected CI workflows.

## Non-negotiable external decisions

Qualified scholar approval, legal/privacy review, production infrastructure,
and pilot users cannot be substituted with agent-generated evidence. The plan
therefore makes each a named release gate with an accountable human owner.

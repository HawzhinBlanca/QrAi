# Architecture Readiness Doc Research

## Target Surface

- `docs/architecture/10-10-platform.md`
  - Current public architecture boundary for implemented and not-yet-implemented platform capabilities.

## Finding

The architecture doc still lists "Production Postgres runtime, SQLx integration, row-level security" under "Still Not Implemented." That is stale:

- `services/platform-api` uses SQLx and a Postgres pool at runtime.
- `infra/sql/0003_tenant_rls.sql`, `0009_learner_progress_rls.sql`, and `0012_superuser_only_rls_bypass.sql` define tenant RLS policies and restricted bypass behavior.
- `begin_tenant_tx` sets `app.tenant_id` per request.
- `bash scripts/verify.sh` runs live Postgres integration tests when the database is reachable.
- `scripts/smoke-sql.mjs` proves RLS policy text and live RLS behavior, including restricted-role bypass protection.

## Acceptance Criteria

- WHEN the architecture doc describes implemented API/storage capabilities, THE doc SHALL include SQLx-backed Postgres runtime and tenant-scoped RLS proof.
- WHEN the architecture doc lists still-open work, THE doc SHALL not list completed SQLx/Postgres/RLS foundations as missing.
- WHEN production gaps are listed, THE doc SHALL preserve real remaining gaps: managed deployment posture, object storage, event bus, production auth provider, mobile proof, real pilot data, and independent full Quran source reconciliation.

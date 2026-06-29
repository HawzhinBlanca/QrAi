# Quran AI Platform API

The platform API will own institution tenancy, auth/RBAC, recitation sessions, teacher reviews, scholar approvals, eval lookup, consent records, and audit events.

Public routes are locked in `packages/contracts`:

- `POST /v1/recitation-sessions`
- `GET /v1/recitation-sessions/:id`
- `WS /v1/recitation-sessions/:id/audio`
- `POST /v1/teacher-reviews`
- `POST /v1/scholar-approvals`
- `GET /v1/eval-runs/:modelVersion`

The initial database target is `infra/sql/0001_core_schema.sql`.

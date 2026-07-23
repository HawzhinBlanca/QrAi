# Research: Pilot identity hardening (post-review fix set)

Date: 2026-07-19. Source: full code review of the working tree during in-flight P1.4
implementation, plus targeted reads of the current code. This is the research artifact
for the fix set planned in `plan.md`. Parent program: `specs/readiness-recovery-10-10/`.

## Current state (verified by reading, not guessed)

**Migration** — `infra/sql/0021_pilot_identity.sql`
- `pilot_invitations` / `pilot_sessions`: text PKs, `token_hash text unique` (tokens
  stored hashed only — correct), `csrf_token text not null` stored plaintext (correct:
  not a bearer credential), FKs to `institutions(id)` / `users(id)` with no cascade
  (house style, cf. `0001_core_schema.sql`).
- RLS enabled + FORCE + `tenant_isolation_*` policies matching the exact regex in
  `scripts/smoke-sql.mjs:71`.
- Two `SECURITY DEFINER` functions: `app.get_pilot_session_by_hash(text)` (sql),
  `app.consume_pilot_invitation_by_hash(text)` (plpgsql, race-safe atomic
  single-use UPDATE). Owner at apply time = the migration-running superuser.

**Rust** — in-flight, all present in working tree:
- `services/platform-api/src/handlers/pilot.rs` (new): `bootstrap` (consumes invitation
  in a tx, checks role == learner, mints uuid-v4 session token, SHA-256 hash stored,
  sets `__Host-qrai-pilot` HttpOnly/Secure/SameSite=Strict cookie, audit event),
  `logout` (revokes via `revoked_at`, clears cookie, audit event).
- `services/platform-api/src/auth.rs`: new `resolve_actor(method, headers, state)` —
  order: Bearer JWT → pilot cookie (hash lookup via definer fn, idle+absolute expiry
  check, Origin+CSRF check on mutating methods, idle-expiry roll, role pinned to
  `ActorRole::Learner`) → dev headers gated by `ALLOW_HEADER_AUTH`.
- All 10 handler files call `resolve_actor`; `actor_from_headers` has zero remaining
  production callers (one stale comment in `progress.rs:287`).
- Routes: `/v1/pilot/session/bootstrap|logout` in `lib.rs:224-231`, inside the
  rate-limited router.
- `begin_tenant_tx` (`lib.rs:406`) sets tenant via bound `set_config($1, true)` —
  the safe house pattern.
- CORS: `CORS_ALLOWED_ORIGINS` env (comma-separated) at `lib.rs:120-131`; permissive
  when unset (dev).

**Wiring** — ci.yml migration list + count (21) updated; docker-compose mounts
`21_pilot_identity.sql`; contracts `CORE_TABLES` + smoke `tenantTables`/TRUNCATE
lists updated; smoke-sql seeds per-tenant rows for both tables.

**Not present anywhere**: pilot tests (services/platform-api/tests/integration.rs has
none for pilot), web-side wiring (apps/web untouched: `lib/api.ts`, `data/platform.ts`,
`lib/serverAsr.ts`, `components/TeacherSurface.tsx` still send x-user-id/x-tenant-id
headers), pilot rows in the privacy erasure enumeration, invitation-issuance runbook.

## Defects to fix (from the review, all confirmed still present)

| # | Sev | Where | Defect |
|---|-----|-------|--------|
| F1 | Critical | 0021:95-96, ci.yml:83, docker-compose | `grant ... to quran_ai_app` runs before the role exists in both bootstrap paths. Fresh `docker compose up` initdb aborts (image runs SQL with ON_ERROR_STOP=1; `21_` sorts before `99_init_app_role.sh`). In CI the loop psql has no ON_ERROR_STOP so the failure is silently swallowed. |
| F2 | Critical | 0021:53,70 | Both SECURITY DEFINER functions lack `set search_path`. Caller-controlled `pg_temp` relation shadowing lets anyone with SQL-as-app-role forge arbitrary tenant/learner sessions — defeats RLS + hashed tokens under the exact threat model rls-app-role.sql documents. |
| F3 | Critical | smoke-sql.mjs:335 | `pilot_sessions` seed insert lacks `csrf_token` (NOT NULL, no default) → live smoke fails. |
| F4 | High | 0021:4-7 | `drop table if exists ... cascade` header makes any re-apply destroy all live pilot sessions/invitations. |
| F5 | High | privacy.rs:218-314 | Erasure enumeration lacks `pilot_invitations`/`pilot_sessions` (learner-keyed identity data) — same gap class fixed for agent_runs in 2d4c8e7. Export counts likewise. |
| F6 | High | pilot.rs:25-34, auth.rs origin block | Origin "check" accepts ANY non-empty Origin — decorative; R4's "bad origin rejected" is currently false. |
| F7 | Med | pilot.rs:62 | `format!("SET LOCAL app.tenant_id = '{}'", tenant_id)` — string-interpolated SQL; second-order only (tenant_id from DB) but violates the `begin_tenant_tx` bound-`set_config` pattern. |
| F8 | Low | auth.rs CSRF block | `csrf_val != csrf_token` non-constant-time compare (needs a valid session cookie to exploit; cheap to harden without new deps by comparing SHA-256 digests). |
| F9 | Low | ci.yml:83 | Migration loop psql lacks `-v ON_ERROR_STOP=1` — SQL errors pass CI green (this is what masked F1). |
| F10 | Process | tasks.md:27-28 | P1.4/P1.5 marked `[x]` with no ledger evidence entries, no tests, and F1–F8 open — violates the ledger's own header rule and AGENTS.md "done" definition. |

## Deployment assumptions surfaced

- SECURITY DEFINER + FORCE RLS works because the migration runner (function owner) is a
  superuser. On managed Postgres without true superuser, FORCE RLS binds the owner and
  both functions return empty → pilot login dead. Must be recorded as a deployment
  constraint and checked at P1.7.
- `ALLOW_HEADER_AUTH` must be unset/false in production for R4's spoofed-header
  rejection to hold; needs a test in both modes and a deploy-checklist line.
- `__Host-`/`Secure` cookie requires TLS (or `localhost`, which browsers exempt) — E2E
  must run on `localhost` or the T12 TLS stack.

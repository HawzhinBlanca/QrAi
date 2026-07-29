# Impact map: pilot identity hardening

Method note: Serena `find_referencing_symbols` is unavailable for the Rust crate in
this workspace (`services/platform-api` is an ignored path in Serena's config — the
call errors with "path is ignored"). Callers below were therefore mapped by
exhaustive `grep -rn` over the repo for each (uniquely named, non-macro) symbol and
cross-checked against the current `git diff`. TS-side symbols in Part B get a full
Serena pass at their own implement step.

## Symbols to be touched (Part A) and their callers

| Symbol (file) | Change | Callers / consumers (all verified) | Tests that must stay green / go green |
|---|---|---|---|
| `app.get_pilot_session_by_hash` (0021) | search_path pin, absolute-expiry filter, revoke PUBLIC, grant relocation | `resolve_actor` (auth.rs, cookie branch); `logout` (pilot.rs:165) | `pilot_definer_fns_resist_temp_table_shadowing`, `pilot_rejects_expired_sessions`, `pilot_rejects_revoked_session_after_logout`, smoke-sql static + live checks |
| `app.consume_pilot_invitation_by_hash` (0021) | search_path pin, revoke PUBLIC, grant relocation | `bootstrap` (pilot.rs:49) | `pilot_invitation_single_use`, `pilot_bootstrap_rejects_expired_invitation` |
| `pilot_invitations`, `pilot_sessions` tables (0021) | drop destructive header lines 4–7 | INSERT: pilot.rs:94 (sessions); UPDATE: auth.rs idle-roll, pilot.rs logout revoke; seeds: smoke-sql.mjs:331,335; TRUNCATE: smoke-all.mjs:70; contracts `CORE_TABLES` (index.ts:97-98, test is `toContain`-only, unaffected); privacy.rs (added by A7) | full pilot test set; `pnpm smoke:all` on fresh volume |
| `rls-app-role.sql` | + 2 grant lines | executed by `99_init_app_role.sh` (compose initdb, last), ci.yml:86, documented manual prod path | fresh-volume compose init + `pnpm smoke:sql` |
| ci.yml migration loop (line 83) | `-v ON_ERROR_STOP=1` | CI only | CI run on branch (an intentionally broken fixture was NOT added — the A4 static asserts cover the regression class) |
| smoke-sql.mjs seed block (line ~335) + new static asserts | csrf_token values; 2 asserts | `pnpm smoke:sql` / `smoke:all`, `scripts/verify.sh` smoke stage | smoke run itself |
| `bootstrap` (pilot.rs:19) | set_config bind (A5), origin allowlist call (A6) | route `/v1/pilot/session/bootstrap` (lib.rs:224); no other callers | bootstrap test trio; `pilot_mutation_rejects_bad_origin` |
| `logout` (pilot.rs:148) | none directly (behavior covered by tests) | route `/v1/pilot/session/logout` (lib.rs:228) | `pilot_rejects_revoked_session_after_logout` |
| `resolve_actor` (auth.rs) | origin allowlist (A6), constant-time CSRF (A8); signature unchanged | 10 handler files, every request-auth call site: agent.rs, audit.rs, handlers/auth.rs, eval.rs, ml_proxy.rs, privacy.rs, progress.rs, recitation.rs, review.rs, user.rs (verified: zero remaining `actor_from_headers` callers) | whole existing integration suite + new pilot set (signature unchanged ⇒ compile-time safety for callers) |
| `AppState` (lib.rs) | + `allowed_origins` field (A6) | constructors `with_header_auth` and siblings (lib.rs:55 region); all `State(state)` extractors compile-checked | `cargo test` compile + origin tests |
| `create_privacy_job` (privacy.rs) | + 2 DELETEs + counts (A7) | `create_privacy_export`, `create_privacy_delete` (same file) → routes in lib.rs; existing privacy integration + smoke privacy path | `privacy_delete_erases_pilot_identity_rows`, `privacy_export_counts_include_pilot_rows`, existing privacy tests |
| tasks.md P1.4/P1.5 checkboxes; docs/DECISIONS.md | ledger honesty + ADR (A10) | humans; CI docs checks none | n/a (doc) |

## Part B files (mapped at file level; symbol pass at implement time)

`apps/web/src/lib/api.ts`, `apps/web/src/data/platform.ts`,
`apps/web/src/lib/serverAsr.ts`, `apps/web/src/components/TeacherSurface.tsx`,
`apps/web/src/App.tsx` (`AuthenticatedApp`, `loadInitialData`) — all current
x-user-id/x-tenant-id senders found by grep; every fetch call site must be listed
via Serena (TS is indexed) before B edits. Planned tests: component header tests +
`pilot-learner-journey` E2E.

## Tests to run per task

- Every task: `bash scripts/verify.sh` (gate; DB tests skip-not-fake without DB).
- A1–A4: additionally `docker compose down -v && docker compose up -d && pnpm smoke:all`
  (fresh volume is the only honest proof for F1).
- A5–A9: `pnpm test` with live Postgres so the DB-gated integration tests actually run.
- Part B: `pnpm typecheck && pnpm test` + browser smoke suite.

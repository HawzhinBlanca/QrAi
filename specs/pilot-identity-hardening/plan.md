# Plan: Pilot identity hardening → honest P1 completion → road to 10/10

**Approved-by:** Hawzhin (owner directive in chat: "you leading the app now … every feature hardened")
**Approval date:** 2026-07-19

Parent program: `specs/readiness-recovery-10-10/` (program plan approved 2026-07-19).
This plan covers (A) the fix set for the defects in `research.md` (F1–F10), (B) the
web wiring that P1.6 requires, and (C) the sequenced remainder of the 10/10 ledger.
Pinned to the working tree observed 2026-07-19; the tree is being edited concurrently,
so the implementer MUST re-run `git diff --stat` and re-confirm F1–F9 before starting.

Rules honored: test-first per constitution; one task at a time; smallest correct
change; `bash scripts/verify.sh` green before any ledger flip; no checkbox without
its evidence entry.

---

## Part A — fix set (ordered; each item = one implement task)

### A1. Make migration 0021 safe and self-contained
File: `infra/sql/0021_pilot_identity.sql`
- Delete the `drop table/function ... cascade` header (lines 4–7) — migrations are
  one-shot per environment (F4).
- Add `set search_path = public, pg_temp` to BOTH function definitions (F2).
- Add `and now() < absolute_expires_at` to `get_pilot_session_by_hash`'s WHERE
  (defense in depth; idle expiry stays app-side because the app rolls it).
- Add `revoke execute on function app.get_pilot_session_by_hash(text) from public;`
  and same for `consume_pilot_invitation_by_hash` (Postgres default-grants EXECUTE
  to PUBLIC, making these session-minting oracles callable by any role).
- DELETE the two `grant ... to quran_ai_app` lines (F1) — they move to A2.
Failing-first proof: new smoke-sql static asserts (A4) go red against the current
file, green after this change.

### A2. Grants live where the role exists
File: `infra/sql/rls-app-role.sql` (idempotent; runs after role creation in compose
via `99_init_app_role.sh` and in CI after the migration loop)
- Add the two `grant execute on function app.*_pilot_*` lines next to the existing
  `grant execute on function app.current_tenant_id()` block (line 40).

### A3. CI fails loudly on SQL errors
File: `.github/workflows/ci.yml` (line 83)
- Add `-v ON_ERROR_STOP=1` to the migration-loop psql invocation (F9). Nothing else
  in the loop changes; the count tripwire (21) is already correct.

### A4. Smoke seeds match schema + regression guards
File: `scripts/smoke-sql.mjs`
- Add `csrf_token` values to both `pilot_sessions` seed rows (line 335) (F3).
- Add two static asserts beside the existing policy regex checks: (1) both definer
  functions in 0021 contain `set search_path`; (2) no numbered migration contains
  `to quran_ai_app` (guards F1/F2 regressions).

### A5. Bootstrap uses the house tenant-context pattern
File: `services/platform-api/src/handlers/pilot.rs` (line 62), symbol `bootstrap`
- Replace `format!("SET LOCAL app.tenant_id = '{}'")` with the bound
  `SELECT set_config('app.tenant_id', $1, true)` inside the same transaction,
  matching `begin_tenant_tx` (F7).

### A6. Real Origin allowlist
Files: `services/platform-api/src/auth.rs` (symbol `resolve_actor`),
`services/platform-api/src/handlers/pilot.rs` (symbol `bootstrap`)
- Reuse the existing `CORS_ALLOWED_ORIGINS` source (lib.rs:120-131): parse once into
  `AppState` (new field, e.g. `allowed_origins: Option<Vec<String>>`; `None` = unset).
- Behavior: when set, a pilot mutating request's Origin MUST be an exact member,
  else 403; when unset (dev), keep current present-and-non-empty behavior (F6).
- Both the bootstrap handler and the resolve_actor mutation branch call one shared
  helper — no duplicated logic.

### A7. Privacy erasure/export covers pilot identity data
File: `services/platform-api/src/handlers/privacy.rs`, symbol `create_privacy_job`
- Add `DELETE FROM pilot_sessions WHERE tenant_id = $1 AND learner_id = $2` and the
  same for `pilot_invitations` inside the existing per-table delete sequence
  (delete kind), and include both tables' row counts in the job accounting the same
  way the existing tables report `included_records`/`deleted_records` (F5).

### A8. Constant-time CSRF compare (cheap hardening)
File: `services/platform-api/src/auth.rs`, symbol `resolve_actor`
- Compare `Sha256(header)` vs `Sha256(stored)` digests instead of raw `!=` (F8).
  No new dependency (sha2 already imported).

### A9. Test suite for the identity boundary (failing-first, lands WITH A1–A8)
File: `services/platform-api/tests/integration.rs` (DB-gated like the rest of the
file; run via `pnpm test` with live Postgres / skipped-not-faked by verify.sh).
Named tests and what each pins — see EARS map below for criterion linkage:
- `pilot_invitation_single_use` — second bootstrap with same token → 401; consumed
  invitation stays consumed on role-check failure rollback path.
- `pilot_bootstrap_rejects_expired_invitation`
- `pilot_bootstrap_rejects_non_learner_invitation`
- `pilot_rejects_spoofed_headers_in_prod_mode` — `ALLOW_HEADER_AUTH` false ⇒
  x-user-id/x-tenant-id/x-user-role ignored ⇒ 401.
- `pilot_rejects_expired_sessions` — idle-expired and absolute-expired variants.
- `pilot_rejects_revoked_session_after_logout`
- `pilot_mutation_rejects_bad_origin` — origin absent, empty, and non-allowlisted
  (with `CORS_ALLOWED_ORIGINS` set) all 403.
- `pilot_mutation_rejects_missing_or_wrong_csrf`
- `pilot_session_cannot_call_admin_endpoints` — cookie actor is pinned Learner;
  admin/ops route → 403 (privilege escalation).
- `pilot_session_reads_only_own_tenant` — tenant-a cookie cannot read tenant-b rows.
- `pilot_definer_fns_resist_temp_table_shadowing` — as the app role, `CREATE TEMP
  TABLE pilot_sessions(...)` with a forged row, then call
  `app.get_pilot_session_by_hash` and assert the forged row is NOT returned
  (fails before A1, passes after — the adversarial proof for F2).
- `privacy_delete_erases_pilot_identity_rows` and
  `privacy_export_counts_include_pilot_rows` (for A7).

### A10. Docs + ledger honesty (no code)
- `docs/DECISIONS.md`: add ADR entry for the pilot identity boundary (architectural
  change; constitution requires it), referencing
  `specs/readiness-recovery-10-10/p1-identity-decision.md` and ADR-0002 (login
  stays off; this adds no login UI).
- `specs/readiness-recovery-10-10/tasks.md`: revert P1.4 and P1.5 to `[ ]` now
  (F10); re-flip each ONLY with its required ledger entry (commit, failing-first
  test names, verify.sh/CI proof, adversarial proof) once A1–A9 are green.
- Record the two deployment constraints from research.md (superuser migration
  runner; `ALLOW_HEADER_AUTH` false in prod) in the deploy checklist doc that P1.7's
  reviewer will challenge, plus a one-page invitation-issuance runbook (ops inserts
  invitation row with SHA-256 of a generated token; no admin endpoint yet — YAGNI).

### A-verification (after each task, and at the end)
`bash scripts/verify.sh` green; then `docker compose down -v && docker compose up -d`
followed by `pnpm smoke:all` — the fresh volume is REQUIRED to prove F1 fixed
(existing volumes mask it). CI green on the branch.

---

## Part B — web wiring so P1.6 can be proven (R3)

Own implement task(s) after Part A; full symbol-level impact map at its implement
step (one-task-at-a-time rule), scoped here at file level from P1.3's mapping:
- `apps/web/src/lib/api.ts` — fetch wrapper: `credentials: 'include'`, attach
  `x-csrf-token` on mutating calls, drop x-user-id/x-tenant-id when pilot session
  is active.
- `apps/web/src/data/platform.ts`, `apps/web/src/lib/serverAsr.ts`,
  `apps/web/src/components/TeacherSurface.tsx` — same header-source change.
- `apps/web/src/App.tsx` (`AuthenticatedApp`, `loadInitialData`) — invite-token
  bootstrap flow (reads token from URL/entry form), store csrfToken in memory (not
  localStorage), logout path. NO login screen (ADR-0002 unchanged).
- Planned tests: component tests for header behavior; browser E2E
  `pilot-learner-journey` in the smoke browser suite — bootstrap → progress loads →
  practice begins → retry/offline recovery → zero 401/console errors (R3/P1.6).
  Runs on `localhost` (or T12 TLS stack) so the `__Host-…; Secure` cookie is kept.

---

## Part C — remaining road to true 10/10 (sequenced, with gates)

The parent ledger `specs/readiness-recovery-10-10/tasks.md` stays the single source
of truth; this is the execution order and the honest gate types. "Agent" = plannable
implementation work; "OWNER" = requires a named human decision/signature that no
generated text may replace (ledger header rule).

1. **P1 close-out** — Part A + Part B above (Agent), then P1.6 evidence run, then
   P1.7 security challenge (OWNER: security reviewer signs).
2. **P0 evidence integrity** — P0.4/P0.5/P0.6 manifest+`verify.sh --release`
   fail-closed gates (Agent, tests exist failing from P0.3); P0.1/P0.2 owner matrix
   + ADR, P0.7/P0.8 independent challenge + doc reconciliation (OWNER).
3. **P2 language/UX truthfulness** — P2.1/P2.2 inventory + manifest tests (Agent);
   P2.3 per-locale keep-or-hide (OWNER: product); P2.4 reviewed Sorani/Arabic packs
   (OWNER: native + Quran-content reviewers); P2.5/P2.6 RTL/a11y/state tests (Agent).
4. **P3 domain/model truth** — P3.1–P3.3 inventory, withheld-feedback and bundle
   audit tests (Agent); P3.4/P3.5 real eval protocol + candidate-bound run (Agent
   scaffolds, OWNER approves protocol); P3.6 scholar signoff (OWNER).
5. **P4 privacy/security** — P4.4 policy gates (Agent); P4.1 threat model, P4.5
   independent assessment, P4.6 privacy/legal signoff (OWNER).
6. **P5 reliability/ops** — P5.2/P5.3 fault tests (Agent); P5.1 SLOs (OWNER);
   P5.4–P5.6 load/chaos/restore drills on the candidate (Agent executes, evidence
   retained); P5.7 SRE signature (OWNER).
7. **P6 accessibility/mobile** — P6.1/P6.2 journey + a11y automation (Agent);
   audits, device matrix, usability study (OWNER-involving).
8. **P7 pilot + go/no-go** — protocol, dogfood, external pilot, fresh candidate,
   independent challenge, formal go/no-go (OWNER-heavy; Agent produces bundles).

Honest constraint, stated plainly: "true complete ready before users" cannot be
reached by code alone — every phase above ends in a named human signature with
expiry. This plan makes each such gate reachable and evidence-backed; it does not
simulate any of them.

---

## Risks

- **Concurrent edits**: another session is editing the same files; re-diff before
  each task, and land A1 (the shared migration) first to stop divergence.
- **Fresh-volume blindness**: F1 is invisible on existing volumes — the
  A-verification step's `down -v` is mandatory, not optional.
- **Managed-PG owner semantics**: FORCE RLS + non-superuser migration owner would
  brick the definer functions (documented in research.md; checked at P1.7).
- **Env-shaped security**: R4 holds only with `ALLOW_HEADER_AUTH` false and
  `CORS_ALLOWED_ORIGINS` set in production — both become deploy-checklist asserts.
- **E2E cookie constraints**: `__Host-`/`Secure` needs localhost or TLS in CI
  browsers; flaky if run against bare 127.0.0.1 in some engines.

## EARS criterion → planned test map (spec: readiness-recovery-10-10/spec.md)

| Criterion | Planned named tests |
|---|---|
| R3 (pilot journey, no 401/console errors) | `pilot-learner-journey` browser E2E (Part B); `pilot_invitation_single_use`, `pilot_bootstrap_rejects_expired_invitation` (bootstrap integrity) |
| R4 (spoofed headers, sessions, origin/CSRF, escalation, crossover) | `pilot_rejects_spoofed_headers_in_prod_mode`, `pilot_rejects_expired_sessions`, `pilot_rejects_revoked_session_after_logout`, `pilot_mutation_rejects_bad_origin`, `pilot_mutation_rejects_missing_or_wrong_csrf`, `pilot_bootstrap_rejects_non_learner_invitation`, `pilot_session_cannot_call_admin_endpoints`, `pilot_session_reads_only_own_tenant`, `pilot_definer_fns_resist_temp_table_shadowing`, smoke-sql static asserts (A4) |
| R7 (privacy lifecycle incl. delete/export) | `privacy_delete_erases_pilot_identity_rows`, `privacy_export_counts_include_pilot_rows` |

---

**STOP.** No implementation starts until a human fills the `Approved-by:` line above.

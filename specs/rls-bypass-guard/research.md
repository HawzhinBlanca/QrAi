# RLS Bypass Guard Research

## Current Behavior

- `app.is_rls_bypass_enabled()` returns true when the session sets `app.bypass_rls` to `on`, `true`, or `1`.
- The helper does not check the current database role.
- A rollback-only red proof showed `quran_ai_rls_test` (`NOSUPERUSER`, `NOBYPASSRLS`) could set `app.bypass_rls=on` and see both temporary tenant rows.

## Risk

The RLS policy bypass is intended for maintenance/smoke setup, but because PostgreSQL custom settings can be set by ordinary roles, a restricted application role can opt into the policy bypass if it ever gets a SQL execution path that can set GUCs.

## Target Behavior

- `app.bypass_rls` is honored only when `current_user` is a superuser.
- Restricted app/test roles stay tenant-scoped even if they set `app.bypass_rls=on`.
- Live SQL smoke proves this with a non-superuser role.

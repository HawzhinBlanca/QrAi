-- Close a real TOCTOU race in registration: `register()` does SELECT-then-INSERT to check email
-- uniqueness, but under READ COMMITTED two concurrent registrations with the same email can both
-- pass the SELECT (neither sees the other's yet-uncommitted row) and both INSERT successfully.
-- Verified empirically: 10 concurrent registrations with an identical email all succeeded, creating
-- 10 distinct users sharing one email — after which `login` by email non-deterministically resolved
-- to whichever row Postgres happened to return, silently logging into an arbitrary one of the 10.
--
-- App-level check-then-insert can NEVER close this race by itself; only a DB constraint can. A
-- partial unique index (per-tenant, only when email is set — NULLs are never equal in SQL, so
-- learners without an email are unaffected) makes the losing concurrent INSERT fail with a
-- unique_violation, which the handler now catches and maps to a clean 400.
create unique index if not exists idx_users_tenant_email_unique
  on users (tenant_id, email)
  where email is not null;

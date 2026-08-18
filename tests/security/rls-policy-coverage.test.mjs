import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createDb } from "../../server/src/lib/db.mjs";

/**
 * Every tenant-scoped table carries a FORCED row-level-security policy, and the policy is the one
 * the design says it is.
 *
 * Tenant isolation in this product is two things: each handler scoping its query, and Postgres
 * refusing rows the handler forgot to scope. The second is the one that survives a mistake, and it
 * is invisible in application code — a table added in a migration with no `ENABLE ROW LEVEL
 * SECURITY` looks exactly like one that has it, from every file a reviewer is likely to open.
 *
 * Nothing checked it. `infra/sql/rls-app-role.sql` creates the policies and the migrations create
 * the tables, and the two could disagree for a whole release without any test noticing. The count
 * had already drifted quietly: `insecure.rs` said "all 16 RLS policies" and there are 17.
 *
 * This derives the list from the database instead of pinning a number, so a NEW tenant-scoped table
 * fails here on the migration that adds it, naming the table — which is the failure worth having,
 * far more than the count being right.
 *
 * DB-gated.
 */

const DATABASE_URL = process.env.DATABASE_URL;
let db;

before(() => {
  db = createDb(DATABASE_URL);
});
after(async () => {
  await db?.end();
});

/** The one predicate every policy is supposed to have, from infra/sql/rls-app-role.sql. */
const EXPECTED_QUAL = "(app.is_rls_bypass_enabled() OR (tenant_id = app.current_tenant_id()))";

async function tenantTables() {
  return db.sql`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema = 'public'
                     AND col.table_name = c.relname
                     AND col.column_name = 'tenant_id')
    ORDER BY c.relname`;
}

test("the scan finds the tenant-scoped tables at all", async () => {
  // Guards every assertion below against passing on an empty set — a query that silently matched
  // nothing would report perfect RLS coverage over zero tables.
  const rows = await tenantTables();
  assert.ok(rows.length >= 15, `only ${rows.length} tenant-scoped tables found; the query is wrong`);
});

test("every tenant-scoped table has RLS ENABLED and FORCED, with a policy", async () => {
  const rows = await tenantTables();
  const bad = rows
    .filter((r) => !r.enabled || !r.forced || Number(r.policies) < 1)
    .map((r) => `${r.table_name} (enabled=${r.enabled} forced=${r.forced} policies=${r.policies})`);

  assert.deepEqual(
    bad,
    [],
    `these tables carry tenant_id and are NOT protected by forced row-level security:\n  ` +
      `${bad.join("\n  ")}\n` +
      `A tenant-scoped table without RLS relies entirely on every handler remembering to filter. ` +
      `Add it to infra/sql/rls-app-role.sql.`,
  );

  // FORCED specifically: without it the table OWNER bypasses the policy, and the owner is whoever
  // the migrations ran as. "Enabled" alone reads like protection and is not.
  assert.ok(rows.every((r) => r.forced), "every policy must be FORCE ROW LEVEL SECURITY");
});

test("every policy is the tenant predicate, not something weaker", async () => {
  // A policy can exist and permit everything. `USING (true)` satisfies "has a policy" and isolates
  // nothing, which is exactly the shape of a check that passes while the property is gone.
  const rows = await db.sql`
    SELECT tablename, policyname, qual, cmd FROM pg_policies WHERE schemaname = 'public'`;
  assert.ok(rows.length > 0, "no policies found at all");

  const wrong = rows
    .filter((r) => r.qual !== EXPECTED_QUAL)
    .map((r) => `${r.tablename}.${r.policyname}: ${r.qual}`);
  assert.deepEqual(wrong, [], `policies that are not the tenant predicate:\n  ${wrong.join("\n  ")}`);

  // ALL, not just SELECT: a SELECT-only policy leaves INSERT/UPDATE/DELETE unrestricted, so a
  // handler that forgot its tenant filter could still WRITE across tenants.
  const notAll = rows.filter((r) => r.cmd !== "ALL").map((r) => `${r.tablename}.${r.policyname} (${r.cmd})`);
  assert.deepEqual(notAll, [], `policies that do not cover every command:\n  ${notAll.join("\n  ")}`);
});

test("the bypass hatch is gated on superuser, so setting a GUC cannot open it", async () => {
  // The policy predicate begins `app.is_rls_bypass_enabled() OR …`, so if that function could be
  // turned on by any session, every policy above would be decorative. It requires `rolsuper` —
  // which is precisely why both services refuse to boot as a superuser role
  // (main.rs:197, and tests/node-api/superuser-role.test.mjs for the port).
  const [fn] = await db.sql`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'is_rls_bypass_enabled'`;
  assert.ok(fn, "app.is_rls_bypass_enabled() is missing; the policies reference it");
  assert.match(fn.def, /rolsuper/, "the bypass is not gated on superuser — any session could set it");

  // And the tenant getter must return NULL when unset, so an unscoped connection matches NO rows
  // rather than some sentinel tenant.
  const [tenantFn] = await db.sql`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'current_tenant_id'`;
  assert.match(tenantFn.def, /nullif/, "an unset tenant must be NULL, so `tenant_id = NULL` matches nothing");
});

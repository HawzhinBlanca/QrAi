import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;

test("provisioning produces a login role that cannot bypass RLS", async (t) => {
  const database = await createTestDatabase(t, "restricted_role");
  if (!database) return;
  const roleName = `qrai_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "quote-' and slash-\\ stay data";
  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    await client.query(`drop owned by "${roleName}" cascade`);
    await client.query(`drop role if exists "${roleName}"`);
    await client.end();
  });

  await migrateDatabase({ connectionString: database.connectionString });
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  const result = await client.query(
    `select r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
            has_schema_privilege($1, 'public', 'usage') as public_usage,
            has_table_privilege($1, 'public.users', 'select') as users_select,
            has_function_privilege($1, 'app.current_tenant_id()', 'execute') as tenant_function
     from pg_roles r where r.rolname = $1`,
    [roleName],
  );
  await client.end();
  assert.deepEqual(result.rows[0], {
    rolcanlogin: true,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    public_usage: true,
    users_select: true,
    tenant_function: true,
  });
});

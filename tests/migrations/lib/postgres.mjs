import { randomUUID } from "node:crypto";

import pg from "pg";

const { Client } = pg;

export function migrationTestAdminUrl() {
  return process.env.MIGRATION_TEST_ADMIN_URL ?? null;
}

export function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createTestDatabase(t, prefix) {
  const adminUrl = migrationTestAdminUrl();
  if (!adminUrl) {
    t.skip("MIGRATION_TEST_ADMIN_URL/DATABASE_URL is not configured");
    return null;
  }

  const databaseName = `qrai_${prefix}_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    t.skip(`Postgres is unreachable at ${adminUrl}: ${err.message}`);
    return null;
  }
  const capability = await admin.query(`
    select r.rolsuper, r.rolcreatedb
    from pg_roles r
    where r.rolname = current_user
  `);
  if (!capability.rows[0]?.rolsuper && !capability.rows[0]?.rolcreatedb) {
    await admin.end();
    throw new Error("migration integration proof requires a CREATEDB-capable administrative connection");
  }

  await admin.query(`create database "${databaseName}" template template0 encoding 'UTF8'`);
  await admin.end();

  const connectionString = databaseUrl(adminUrl, databaseName);
  t.after(async () => {
    try {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await cleanup.query(`drop database if exists "${databaseName}"`);
      await cleanup.end();
    } catch {
      // ignore
    }
  });

  return { connectionString, databaseName };
}

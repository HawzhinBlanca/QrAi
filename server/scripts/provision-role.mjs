import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const provisionSqlPath = join(repositoryRoot, "infra", "provision", "app-role.sql");
const roleNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

/** @typedef {{ connectionString?: string, password?: string, roleName?: string }} ProvisionOptions */
/** @param {ProvisionOptions} options */
export async function provisionApplicationRole(options) {
  const resolvedOptions = options ?? {};
  const connectionString = resolvedOptions.connectionString;
  const password = resolvedOptions.password;
  const roleName = resolvedOptions.roleName ?? "quran_ai_app";
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is required for role provisioning");
  }
  if (typeof password !== "string" || password.length < 16) {
    throw new Error("APP_DATABASE_PASSWORD must contain at least 16 characters");
  }
  if (!roleNamePattern.test(roleName)) {
    throw new Error("APP_DATABASE_ROLE must be a safe unquoted Postgres role name");
  }

  const sql = await readFile(provisionSqlPath, "utf8");
  const client = new Client({ connectionString, application_name: "qrai-role-provisioner" });
  await client.connect();
  try {
    const authority = await client.query(`
      select r.rolsuper, r.rolcreaterole
      from pg_roles r where r.rolname = current_user
    `);
    if (!authority.rows[0]?.rolsuper && !authority.rows[0]?.rolcreaterole) {
      throw new Error("role provisioning requires a superuser or CREATEROLE administrative connection");
    }

    await client.query("begin");
    try {
      await client.query(
        "select set_config('qrai.app_role', $1, true), set_config('qrai.app_password', $2, true)",
        [roleName, password],
      );
      await client.query(sql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
  return { roleName, restricted: true };
}

async function main() {
  const result = await provisionApplicationRole({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    password: process.env.APP_DATABASE_PASSWORD,
    roleName: process.env.APP_DATABASE_ROLE ?? "quran_ai_app",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`role provisioning failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

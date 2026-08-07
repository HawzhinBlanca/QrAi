import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultMigrationsDirectory = join(repositoryRoot, "infra", "migrations");
const migrationFilename = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const advisoryLockKeys = [1364345161, 1];

/** @typedef {{ id: string, filename: string, checksum: string, sql: string }} Migration */
/** @typedef {{ fingerprint: string, migrationCount: number }} LegacyBaseline */
/** @typedef {{ connectionString?: string, migrationsDirectory?: string, legacyBaselines?: Record<string, LegacyBaseline> }} MigrateOptions */

/** @param {Buffer | string} value */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, any>}
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

/** @param {string} [migrationsDirectory]
 * @returns {Promise<Migration[]>}
 */
export async function loadMigrationPlan(migrationsDirectory = defaultMigrationsDirectory) {
  const manifestPath = join(migrationsDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertObject(manifest, "migration manifest");
  if (manifest.schemaVersion !== "qrai-migrations/v1" || !Array.isArray(manifest.migrations)) {
    throw new Error("migration manifest must use qrai-migrations/v1 and contain migrations[]");
  }

  const diskFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const plan = /** @type {Migration[]} */ ([]);
  const ids = new Set();
  const filenames = new Set();
  for (const [index, entry] of manifest.migrations.entries()) {
    assertObject(entry, `migration manifest entry ${index}`);
    const match = migrationFilename.exec(entry.filename);
    if (!match || entry.id !== match[1]) {
      throw new Error(`invalid migration id/filename pair at manifest entry ${index}`);
    }
    if (!checksumPattern.test(entry.sha256)) {
      throw new Error(`invalid sha256 for ${entry.filename}`);
    }
    if (ids.has(entry.id) || filenames.has(entry.filename)) {
      throw new Error(`duplicate migration id or filename: ${entry.id}/${entry.filename}`);
    }
    if (index > 0 && manifest.migrations[index - 1].id >= entry.id) {
      throw new Error(`migration ids are not strictly increasing at ${entry.id}`);
    }
    ids.add(entry.id);
    filenames.add(entry.filename);

    const bytes = await readFile(join(migrationsDirectory, entry.filename));
    const checksum = sha256(bytes);
    if (checksum !== entry.sha256) {
      throw new Error(`source checksum mismatch for ${entry.filename}: manifest=${entry.sha256} actual=${checksum}`);
    }
    plan.push({ id: entry.id, filename: entry.filename, checksum, sql: bytes.toString("utf8") });
  }

  const manifestFiles = plan.map(({ filename }) => filename);
  if (JSON.stringify(diskFiles) !== JSON.stringify(manifestFiles)) {
    throw new Error(`migration manifest/file set mismatch: disk=${diskFiles.join(",")} manifest=${manifestFiles.join(",")}`);
  }
  return plan;
}

/** @param {string} migrationsDirectory
 * @returns {Promise<Record<string, LegacyBaseline>>}
 */
async function loadLegacyBaselines(migrationsDirectory) {
  const document = JSON.parse(await readFile(join(migrationsDirectory, "legacy-baselines.json"), "utf8"));
  assertObject(document, "legacy baseline manifest");
  if (document.schemaVersion !== "qrai-legacy-schema-baselines/v1") {
    throw new Error("legacy baseline manifest must use qrai-legacy-schema-baselines/v1");
  }
  assertObject(document.baselines, "legacy baseline map");
  return /** @type {Record<string, LegacyBaseline>} */ (document.baselines);
}

async function queryRows(client, sql) {
  return (await client.query(sql)).rows;
}

export async function computeSchemaFingerprint(client) {
  const document = {
    schemaVersion: "qrai-schema-fingerprint/v1",
    relations: await queryRows(client, `
      select n.nspname as schema_name, c.relname as relation_name, c.relkind,
             c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app', 'public')
        and c.relkind in ('r', 'p', 'S', 'v', 'm')
        and c.relname <> 'schema_migrations'
      order by 1, 2, 3
    `),
    columns: await queryRows(client, `
      select table_schema as schema_name, table_name, ordinal_position, column_name,
             data_type, udt_schema, udt_name, is_nullable, column_default,
             is_identity, identity_generation, is_generated, generation_expression
      from information_schema.columns
      where table_schema in ('app', 'public') and table_name <> 'schema_migrations'
      order by 1, 2, 3
    `),
    constraints: await queryRows(client, `
      select n.nspname as schema_name, c.relname as table_name, con.conname as constraint_name,
             con.contype, con.condeferrable, con.condeferred, con.convalidated,
             pg_get_constraintdef(con.oid, true) as definition
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app', 'public') and c.relname <> 'schema_migrations'
      order by 1, 2, 3
    `),
    indexes: await queryRows(client, `
      select schemaname as schema_name, tablename as table_name, indexname as index_name, indexdef
      from pg_indexes
      where schemaname in ('app', 'public') and tablename <> 'schema_migrations'
      order by 1, 2, 3
    `),
    policies: await queryRows(client, `
      select schemaname as schema_name, tablename as table_name, policyname as policy_name,
             permissive, roles, cmd, qual, with_check
      from pg_policies
      where schemaname in ('app', 'public') and tablename <> 'schema_migrations'
      order by 1, 2, 3
    `),
    functions: await queryRows(client, `
      select n.nspname as schema_name, p.proname as function_name,
             pg_get_function_identity_arguments(p.oid) as identity_arguments,
             pg_get_function_result(p.oid) as result_type,
             p.provolatile, p.prosecdef, p.proleakproof,
             pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'public')
      order by 1, 2, 3
    `),
    triggers: await queryRows(client, `
      select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
             pg_get_triggerdef(t.oid, true) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ('app', 'public')
        and c.relname <> 'schema_migrations'
      order by 1, 2, 3
    `),
  };
  return { hash: sha256(JSON.stringify(document)), document };
}

async function ensureMigrationLedger(client) {
  await client.query("begin");
  try {
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key check (id ~ '^[0-9]{4}$'),
        filename text not null unique,
        checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now(),
        execution_ms integer not null check (execution_ms >= 0),
        adopted boolean not null default false
      )
    `);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * @param {Migration[]} plan
 * @param {{ id: string, filename: string, checksum: string, adopted: boolean }[]} rows
 */
function validateLedger(plan, rows) {
  const byId = new Map(plan.map((migration) => [migration.id, migration]));
  const appliedIds = new Set();
  for (const row of rows) {
    const migration = byId.get(row.id);
    if (!migration) throw new Error(`database ledger contains unknown migration ${row.id}`);
    if (row.filename !== migration.filename) {
      throw new Error(`filename drift for migration ${row.id}: database=${row.filename} source=${migration.filename}`);
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(`checksum drift for migration ${row.id}: database=${row.checksum} source=${migration.checksum}`);
    }
    appliedIds.add(row.id);
  }
  let foundGap = false;
  for (const migration of plan) {
    if (!appliedIds.has(migration.id)) foundGap = true;
    else if (foundGap) throw new Error(`database ledger has migration ${migration.id} after an unapplied predecessor`);
  }
}

async function hasLegacyObjects(client) {
  const result = await client.query(`
    select exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app', 'public') and c.relkind in ('r', 'p', 'S', 'v', 'm')
        and c.relname <> 'schema_migrations'
    ) as present
  `);
  return result.rows[0].present;
}

/**
 * @param {import("pg").Client} client
 * @param {Migration[]} plan
 * @param {Record<string, LegacyBaseline>} baselines
 */
async function adoptLegacySchema(client, plan, baselines) {
  const fingerprint = await computeSchemaFingerprint(client);
  const matches = Object.entries(baselines).filter(([, value]) => value?.fingerprint === fingerprint.hash);
  if (matches.length !== 1) {
    throw new Error(`unrecognized legacy schema fingerprint ${fingerprint.hash}; refusing to invent migration history`);
  }
  const [through, baseline] = matches[0];
  const adopted = plan.filter(({ id }) => id <= through);
  if (adopted.length !== baseline.migrationCount || adopted.at(-1)?.id !== through) {
    throw new Error(`legacy baseline ${through} does not match the current migration prefix`);
  }

  await client.query("begin");
  try {
    for (const migration of adopted) {
      await client.query(
        `insert into schema_migrations (id, filename, checksum, execution_ms, adopted)
         values ($1, $2, $3, 0, true)`,
        [migration.id, migration.filename, migration.checksum],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return adopted.length;
}

/** @param {MigrateOptions} options */
export async function migrateDatabase({
  connectionString,
  migrationsDirectory = defaultMigrationsDirectory,
  legacyBaselines,
} = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is required; runtime DATABASE_URL is not used implicitly");
  }
  const plan = await loadMigrationPlan(migrationsDirectory);
  const baselines = legacyBaselines ?? await loadLegacyBaselines(migrationsDirectory);
  const client = new Client({ connectionString, application_name: "qrai-migration-runner" });
  let locked = false;
  let adopted = 0;
  let applied = 0;
  await client.connect();
  try {
    const authority = await client.query(`
      select current_user as role_name,
             has_schema_privilege(current_user, 'public', 'create') as can_create
    `);
    if (authority.rows[0].role_name === "quran_ai_app" || !authority.rows[0].can_create) {
      throw new Error("migration runner requires an owner/admin connection, never the restricted application role");
    }

    await client.query("select pg_advisory_lock($1, $2)", advisoryLockKeys);
    locked = true;
    await ensureMigrationLedger(client);

    let rows = (await client.query("select id, filename, checksum, adopted from schema_migrations order by id")).rows;
    validateLedger(plan, rows);
    if (rows.length === 0 && await hasLegacyObjects(client)) {
      adopted = await adoptLegacySchema(client, plan, baselines);
      rows = (await client.query("select id, filename, checksum, adopted from schema_migrations order by id")).rows;
      validateLedger(plan, rows);
    }

    const appliedIds = new Set(rows.map(({ id }) => id));
    for (const migration of plan) {
      if (appliedIds.has(migration.id)) continue;
      const startedAt = performance.now();
      await client.query("begin");
      try {
        await client.query(migration.sql);
        const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
        await client.query(
          `insert into schema_migrations (id, filename, checksum, execution_ms, adopted)
           values ($1, $2, $3, $4, false)`,
          [migration.id, migration.filename, migration.checksum, executionMs],
        );
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback");
        throw new Error(`migration ${migration.filename} failed: ${error.message}`);
      }
    }

    return { applied, adopted, total: plan.length };
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock($1, $2)", advisoryLockKeys).catch(() => {});
    }
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => !["--fingerprint"].includes(argument))) {
    throw new Error("usage: node server/scripts/migrate.mjs [--fingerprint]");
  }
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  const result = await migrateDatabase({ connectionString });
  let output = result;
  if (args.includes("--fingerprint")) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      output = { ...result, fingerprint: (await computeSchemaFingerprint(client)).hash };
    } finally {
      await client.end();
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

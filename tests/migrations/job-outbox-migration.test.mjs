import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;

const appConnectionString = (connectionString, roleName, password) => {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
};

async function seedJob(client, { id, tenantId, actorId, auditId, key, status = "queued" }) {
  await client.query(
    `insert into background_jobs
       (id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, status,
        max_attempts, available_at, audit_event_id)
     values ($1, $2, 'session.finalize', $1, $3, $4, $5::jsonb, $6, 5, now(), $7)`,
    [id, tenantId, actorId, key, JSON.stringify({ sessionId: id }), status, auditId],
  );
}

test("0034 adds one constrained, forced-RLS background job outbox", async (t) => {
  const database = await createTestDatabase(t, "background_jobs_schema");
  if (!database) return;

  const plan = await loadMigrationPlan();
  const jobMigration = plan.find(({ id }) => id === "0034");
  assert.equal(jobMigration?.filename, "0034_background_jobs.sql");
  assert.equal(
    jobMigration?.checksum,
    "e1d8e823b9c3564d6d40a8a67b09edd2db79fe5a1bbac6975874b4e26d7a61ac",
  );
  await migrateDatabase({ connectionString: database.connectionString });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  try {
    const relation = await admin.query(
      `select relrowsecurity, relforcerowsecurity
         from pg_class where oid = 'background_jobs'::regclass`,
    );
    assert.deepEqual(relation.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    const policy = await admin.query(
      `select cmd, qual, with_check
         from pg_policies
        where schemaname = 'public' and tablename = 'background_jobs'
          and policyname = 'tenant_isolation_background_jobs'`,
    );
    assert.equal(policy.rows.length, 1);
    assert.match(policy.rows[0].qual, /tenant_id = app\.current_tenant_id\(\)/);
    assert.match(policy.rows[0].with_check, /tenant_id = app\.current_tenant_id\(\)/);

    const indexes = (
      await admin.query(
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'background_jobs' order by indexname`,
      )
    ).rows;
    assert.ok(indexes.some(({ indexname }) => indexname === "background_jobs_tenant_kind_key_unique"));
    assert.ok(indexes.some(({ indexname, indexdef }) =>
      indexname === "background_jobs_ready" && /WHERE \(status = ANY/.test(indexdef)));
    assert.ok(indexes.some(({ indexname, indexdef }) =>
      indexname === "background_jobs_expired_lease" && /status = 'running'/.test(indexdef)));
    assert.ok(indexes.some(({ indexname, indexdef }) =>
      indexname === "background_jobs_dead" && /status = 'dead'/.test(indexdef)));

    await assert.rejects(
      admin.query(
        `insert into background_jobs
           (id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, status,
            max_attempts, available_at, audit_event_id)
         values ('bad-payload', 'hikmah-pilot-erbil', 'session.finalize', 'session', 'ops-1',
                 'bad-payload', '[]', 'queued', 5, now(), 'audit-seed-align-1')`,
      ),
      /payload|check constraint/i,
    );
    await assert.rejects(
      admin.query(
        `insert into background_jobs
           (id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, status,
            max_attempts, available_at, audit_event_id)
         values ('bad-complete', 'hikmah-pilot-erbil', 'session.finalize', 'session', 'ops-1',
                 'bad-complete', '{}', 'completed', 5, now(), 'audit-seed-align-1')`,
      ),
      /state|check constraint/i,
    );
  } finally {
    await admin.end();
  }
});

test("the restricted role leases only its tenant and SKIP LOCKED gives concurrent workers distinct jobs", async (t) => {
  const database = await createTestDatabase(t, "background_jobs_rls");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_jobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "job-test-password-long";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });

  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const suffix = randomUUID();
  const tenantB = `tenant-jobs-${suffix}`;
  const actorB = `ops-jobs-${suffix}`;
  const auditB = `audit-jobs-${suffix}`;
  try {
    await admin.query(
      "insert into institutions (id, name, region) values ($1, 'Job tenant', 'test')",
      [tenantB],
    );
    await admin.query(
      "insert into users (id, tenant_id, display_name, role, language) values ($1, $2, 'Ops', 'ops', 'en')",
      [actorB, tenantB],
    );
    await admin.query(
      `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
       values ($1, $2, $3, 'test.seed', 'background_job', $1)`,
      [auditB, tenantB, actorB],
    );
    await seedJob(admin, {
      id: `job-a1-${suffix}`,
      tenantId: "hikmah-pilot-erbil",
      actorId: "ops-1",
      auditId: "audit-seed-align-1",
      key: `key-a1-${suffix}`,
    });
    await seedJob(admin, {
      id: `job-a2-${suffix}`,
      tenantId: "hikmah-pilot-erbil",
      actorId: "ops-1",
      auditId: "audit-seed-align-1",
      key: `key-a2-${suffix}`,
    });
    await seedJob(admin, {
      id: `job-b-${suffix}`,
      tenantId: tenantB,
      actorId: actorB,
      auditId: auditB,
      key: `key-b-${suffix}`,
    });
  } finally {
    await admin.end();
  }

  const first = new Client({ connectionString: appConnectionString(database.connectionString, roleName, password) });
  const second = new Client({ connectionString: appConnectionString(database.connectionString, roleName, password) });
  await first.connect();
  await second.connect();
  try {
    for (const client of [first, second]) {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', 'hikmah-pilot-erbil', true)");
    }
    const firstClaim = await first.query(
      `select id from background_jobs
        where status = 'queued' and available_at <= now()
        order by priority desc, available_at, created_at, id
        for update skip locked limit 1`,
    );
    const secondClaim = await second.query(
      `select id from background_jobs
        where status = 'queued' and available_at <= now()
        order by priority desc, available_at, created_at, id
        for update skip locked limit 1`,
    );
    assert.equal(firstClaim.rows.length, 1);
    assert.equal(secondClaim.rows.length, 1);
    assert.notEqual(firstClaim.rows[0].id, secondClaim.rows[0].id);
    assert.ok(firstClaim.rows[0].id.startsWith("job-a"));
    assert.ok(secondClaim.rows[0].id.startsWith("job-a"));

    const visible = await second.query("select id from background_jobs order by id");
    assert.equal(visible.rows.some(({ id }) => id.startsWith("job-b")), false);
  } finally {
    await first.query("rollback").catch(() => {});
    await second.query("rollback").catch(() => {});
    await first.end();
    await second.end();
  }
});

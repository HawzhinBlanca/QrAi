import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const appConnectionString = (connectionString, roleName, password) => {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
};

async function seedIdentityRows(client, suffix) {
  const tenantId = `tenant-device-${suffix}`;
  const userId = `learner-device-${suffix}`;
  const adminId = `admin-device-${suffix}`;
  const auditId = `audit-device-${suffix}`;
  const invitationId = `device-invitation-${suffix}`;
  const sessionId = `device-session-${suffix}`;
  const familyId = `device-family-${suffix}`;
  await client.query(
    "insert into institutions (id, name, region) values ($1, 'Device tenant', 'test')",
    [tenantId],
  );
  await client.query(
    `insert into users (id, tenant_id, display_name, role, language) values
       ($1, $3, 'Device learner', 'learner', 'ckb'),
       ($2, $3, 'Device admin', 'admin', 'ckb')`,
    [userId, adminId, tenantId],
  );
  await client.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     values ($1, $2, $3, 'device.test.seed', 'user', $4)`,
    [auditId, tenantId, adminId, userId],
  );
  await client.query(
    `insert into device_enrollment_invitations
       (id, tenant_id, user_id, created_by, token_hash, expires_at, audit_event_id)
     values ($1, $2, $3, $4, $5, now() + interval '1 hour', $6)`,
    [invitationId, tenantId, userId, adminId, HASH_A, auditId],
  );
  await client.query(
    `insert into device_sessions
       (id, family_id, tenant_id, user_id, generation, access_token_hash,
        refresh_token_hash, status, access_expires_at, idle_expires_at,
        absolute_expires_at, audit_event_id)
     values ($1, $2, $3, $4, 0, $5, $6, 'active', now() + interval '15 minutes',
             now() + interval '7 days', now() + interval '30 days', $7)`,
    [sessionId, familyId, tenantId, userId, HASH_A, HASH_B, auditId],
  );
  return { tenantId, userId, invitationId, sessionId, familyId };
}

test("0035 adds constrained forced-RLS device invitation and rotation-generation state", async (t) => {
  const database = await createTestDatabase(t, "device_identity_schema");
  if (!database) return;

  const plan = await loadMigrationPlan();
  const deviceMigration = plan.find(({ id }) => id === "0035");
  assert.equal(deviceMigration?.filename, "0035_device_identity.sql");
  await migrateDatabase({ connectionString: database.connectionString });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  try {
    const relations = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where oid in ('device_enrollment_invitations'::regclass, 'device_sessions'::regclass)
        order by relname`,
    );
    assert.deepEqual(relations.rows, [
      { relname: "device_enrollment_invitations", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "device_sessions", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const policies = await admin.query(
      `select tablename, cmd, qual, with_check from pg_policies
        where schemaname = 'public'
          and tablename in ('device_enrollment_invitations', 'device_sessions')
        order by tablename`,
    );
    assert.equal(policies.rows.length, 2);
    for (const policy of policies.rows) {
      assert.match(policy.qual, /tenant_id = app\.current_tenant_id\(\)/);
      assert.match(policy.with_check, /tenant_id = app\.current_tenant_id\(\)/);
    }

    const indexes = (
      await admin.query(
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public'
            and tablename in ('device_enrollment_invitations', 'device_sessions')
          order by indexname`,
      )
    ).rows;
    assert.ok(indexes.some(({ indexname }) => indexname === "device_enrollment_token_hash_unique"));
    assert.ok(indexes.some(({ indexname }) => indexname === "device_session_access_hash_unique"));
    assert.ok(indexes.some(({ indexname }) => indexname === "device_session_refresh_hash_unique"));
    assert.ok(indexes.some(({ indexname }) => indexname === "device_session_family_generation_unique"));
    assert.ok(indexes.some(({ indexname, indexdef }) =>
      indexname === "device_session_one_active_generation" && /WHERE \(status = 'active'/.test(indexdef)));

    const functions = await admin.query(
      `select p.proname, p.prosecdef, p.proconfig,
              exists (
                select 1
                  from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as privilege
                 where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
              ) as public_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname in (
          'consume_device_enrollment_invitation_by_hash',
          'get_device_session_by_access_hash',
          'get_device_session_by_refresh_hash'
        ) order by p.proname`,
    );
    assert.equal(functions.rows.length, 3);
    for (const fn of functions.rows) {
      assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
      assert.ok(
        fn.proconfig?.some((value) => value === "search_path=public, pg_temp"),
        `${fn.proname} must pin public before pg_temp`,
      );
      assert.equal(fn.public_execute, false, `${fn.proname} still grants execute to PUBLIC`);
    }

    await assert.rejects(
      admin.query(
        `insert into device_enrollment_invitations
           (id, tenant_id, user_id, created_by, token_hash, expires_at, audit_event_id)
         values ('bad-device-hash', 'hikmah-pilot-erbil', 'learner-1', 'admin-1', 'raw-token',
                 now() + interval '1 hour', 'audit-seed-align-1')`,
      ),
      /token_hash|check constraint/i,
    );
    await assert.rejects(
      admin.query(
        `insert into device_sessions
           (id, family_id, previous_session_id, tenant_id, user_id, generation,
            access_token_hash, refresh_token_hash, status, access_expires_at,
            idle_expires_at, absolute_expires_at, audit_event_id)
         values ('bad-device-generation', 'family', null, 'hikmah-pilot-erbil', 'learner-1', 1,
                 $1, $2, 'active', now() + interval '15 minutes', now() + interval '7 days',
                 now() + interval '30 days', 'audit-seed-align-1')`,
        ["c".repeat(64), "d".repeat(64)],
      ),
      /lineage|check constraint/i,
    );
  } finally {
    await admin.end();
  }
});

test("restricted roles see one tenant while exact hash discovery remains the only pre-tenant oracle", async (t) => {
  const database = await createTestDatabase(t, "device_identity_rls");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_device_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "device-test-password-long";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const suffix = randomUUID();
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  let seeded;
  try {
    seeded = await seedIdentityRows(admin, suffix);
  } finally {
    await admin.end();
  }

  const restricted = new Client({
    connectionString: appConnectionString(database.connectionString, roleName, password),
  });
  await restricted.connect();
  try {
    await restricted.query("begin");
    await restricted.query("select set_config('app.tenant_id', 'hikmah-pilot-erbil', true)");
    assert.equal((await restricted.query("select id from device_sessions")).rows.length, 0);
    assert.equal((await restricted.query("select id from device_enrollment_invitations")).rows.length, 0);
    await restricted.query("rollback");

    const access = await restricted.query(
      "select tenant_id, user_id, role from app.get_device_session_by_access_hash($1)",
      [HASH_A],
    );
    assert.deepEqual(access.rows, [{ tenant_id: seeded.tenantId, user_id: seeded.userId, role: "learner" }]);
    const missing = await restricted.query(
      "select * from app.get_device_session_by_access_hash($1)",
      ["f".repeat(64)],
    );
    assert.equal(missing.rows.length, 0);
  } finally {
    await restricted.end();
  }
});

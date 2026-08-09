import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;
const TENANT_A = "hikmah-pilot-erbil";
const SESSION_A = "session-seed-fatihah-1";
const U64_MAX = "18446744073709551615";

function runtimeUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function seedTenantSession(client, suffix) {
  const tenantId = `tenant-replay-${suffix}`;
  const learnerId = `learner-replay-${suffix}`;
  const consentId = `consent-replay-${suffix}`;
  const sessionId = `session-replay-${suffix}`;
  const consentAuditId = `audit-replay-consent-${suffix}`;
  const sessionAuditId = `audit-replay-session-${suffix}`;
  await client.query(
    "insert into institutions (id, name, region) values ($1, 'Replay tenant', 'test')",
    [tenantId],
  );
  await client.query(
    `insert into users (id, tenant_id, display_name, role, language)
     values ($1, $2, 'Replay learner', 'learner', 'ckb')`,
    [learnerId, tenantId],
  );
  await client.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) values
       ($1, $3, $4, 'replay.test.consent', 'consent_record', $5),
       ($2, $3, $4, 'replay.test.session', 'recitation_session', $6)`,
    [consentAuditId, sessionAuditId, tenantId, learnerId, consentId, sessionId],
  );
  await client.query(
    `insert into consent_records
       (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
     values ($1, $2, $3, 'discard', false, false, true, 'replay-test-v1', $4)`,
    [consentId, tenantId, learnerId, consentAuditId],
  );
  await client.query(
    `insert into recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        external_processing_allowed, confidence, review_status, started_at, latency_ms,
        consent_record_id, audit_event_id)
     values ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
             'replay-test-checksum', 'model-v0.3', 'guided-recite', false, 0, 'draft',
             now(), 0, $4, $5)`,
    [sessionId, tenantId, learnerId, consentId, sessionAuditId],
  );
  return { tenantId, learnerId, sessionId };
}

async function insertClaim(client, {
  tenantId,
  sessionId,
  nonceHash,
  expiresAtUnixSeconds = "2000000300",
}) {
  return client.query(
    `insert into realtime_ticket_replay_claims
       (tenant_id, session_id, nonce_hash, expires_at_unix_seconds)
     values ($1, $2, $3, $4::numeric)`,
    [tenantId, sessionId, nonceHash, expiresAtUnixSeconds],
  );
}

test("0036 adds one checksum-locked forced-RLS nonce replay authority", async (t) => {
  const database = await createTestDatabase(t, "realtime_replay_schema");
  if (!database) return;

  const plan = await loadMigrationPlan();
  assert.equal(plan.length, 36);
  const replayMigration = plan.find(({ id }) => id === "0036");
  assert.deepEqual(
    { id: replayMigration?.id, filename: replayMigration?.filename },
    { id: "0036", filename: "0036_realtime_ticket_replay.sql" },
  );
  await migrateDatabase({ connectionString: database.connectionString });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  try {
    const relation = await admin.query(
      `select relrowsecurity, relforcerowsecurity
         from pg_class where oid = 'realtime_ticket_replay_claims'::regclass`,
    );
    assert.deepEqual(relation.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    const columns = await admin.query(
      `select column_name, data_type, numeric_precision, numeric_scale, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'realtime_ticket_replay_claims'
        order by ordinal_position`,
    );
    assert.deepEqual(columns.rows, [
      { column_name: "tenant_id", data_type: "text", numeric_precision: null, numeric_scale: null, is_nullable: "NO" },
      { column_name: "session_id", data_type: "text", numeric_precision: null, numeric_scale: null, is_nullable: "NO" },
      { column_name: "nonce_hash", data_type: "text", numeric_precision: null, numeric_scale: null, is_nullable: "NO" },
      { column_name: "expires_at_unix_seconds", data_type: "numeric", numeric_precision: 20, numeric_scale: 0, is_nullable: "NO" },
      { column_name: "claimed_at", data_type: "timestamp with time zone", numeric_precision: null, numeric_scale: null, is_nullable: "NO" },
    ]);
    const claimedAtDefault = await admin.query(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'realtime_ticket_replay_claims'
          and column_name = 'claimed_at'`,
    );
    assert.match(claimedAtDefault.rows[0]?.column_default ?? "", /clock_timestamp\(\)/);

    const constraints = await admin.query(
      `select conname, contype, pg_get_constraintdef(oid, true) as definition
         from pg_constraint
        where conrelid = 'realtime_ticket_replay_claims'::regclass
        order by conname`,
    );
    const byName = new Map(constraints.rows.map((row) => [row.conname, row]));
    assert.match(byName.get("realtime_ticket_replay_claims_pkey")?.definition ?? "", /PRIMARY KEY \(tenant_id, session_id, nonce_hash\)/);
    assert.match(byName.get("realtime_ticket_replay_nonce_hash_check")?.definition ?? "", /\^\[0-9a-f\]\{64\}\$/);
    assert.match(byName.get("realtime_ticket_replay_expiry_check")?.definition ?? "", /18446744073709551615/);
    assert.match(byName.get("realtime_ticket_replay_session_fk")?.definition ?? "", /FOREIGN KEY \(tenant_id, session_id\).*recitation_sessions\(tenant_id, id\).*ON DELETE CASCADE/i);

    const sessionConstraint = await admin.query(
      `select pg_get_constraintdef(oid, true) as definition
         from pg_constraint
        where conrelid = 'recitation_sessions'::regclass
          and conname = 'recitation_sessions_tenant_id_id_unique'`,
    );
    assert.match(sessionConstraint.rows[0]?.definition ?? "", /UNIQUE \(tenant_id, id\)/);

    const policy = await admin.query(
      `select cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = 'realtime_ticket_replay_claims'
          and policyname = 'tenant_isolation_realtime_ticket_replay_claims'`,
    );
    assert.equal(policy.rows.length, 1);
    assert.match(policy.rows[0].qual, /tenant_id = app\.current_tenant_id\(\)/);
    assert.match(policy.rows[0].with_check, /tenant_id = app\.current_tenant_id\(\)/);

    const indexes = await admin.query(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'realtime_ticket_replay_claims'
        order by indexname`,
    );
    assert.ok(indexes.rows.some(({ indexname, indexdef }) =>
      indexname === "realtime_ticket_replay_expiry" &&
      /\(tenant_id, expires_at_unix_seconds, session_id, nonce_hash\)/.test(indexdef)));

    await insertClaim(admin, {
      tenantId: TENANT_A,
      sessionId: SESSION_A,
      nonceHash: "a".repeat(64),
      expiresAtUnixSeconds: U64_MAX,
    });
    await assert.rejects(
      insertClaim(admin, { tenantId: TENANT_A, sessionId: SESSION_A, nonceHash: "raw-nonce" }),
      /nonce_hash|check constraint/i,
    );
    await assert.rejects(
      insertClaim(admin, {
        tenantId: TENANT_A,
        sessionId: SESSION_A,
        nonceHash: "b".repeat(64),
        expiresAtUnixSeconds: "18446744073709551616",
      }),
      /expiry|check constraint/i,
    );
    await assert.rejects(
      insertClaim(admin, {
        tenantId: TENANT_A,
        sessionId: SESSION_A,
        nonceHash: "b".repeat(64),
        expiresAtUnixSeconds: "-1",
      }),
      /expiry|check constraint/i,
    );
    await assert.rejects(
      insertClaim(admin, {
        tenantId: TENANT_A,
        sessionId: SESSION_A,
        nonceHash: "a".repeat(64),
        expiresAtUnixSeconds: U64_MAX,
      }),
      /duplicate key|unique constraint/i,
    );
  } finally {
    await admin.end();
  }
});

test("restricted replay rows are tenant-isolated and session privacy deletion cascades", async (t) => {
  const database = await createTestDatabase(t, "realtime_replay_rls");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_replay_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "replay-migration-test-password";
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
  let tenantB;
  try {
    tenantB = await seedTenantSession(admin, suffix);
    await insertClaim(admin, {
      tenantId: TENANT_A,
      sessionId: SESSION_A,
      nonceHash: "c".repeat(64),
      expiresAtUnixSeconds: U64_MAX,
    });
    await insertClaim(admin, {
      tenantId: tenantB.tenantId,
      sessionId: tenantB.sessionId,
      nonceHash: "d".repeat(64),
      expiresAtUnixSeconds: U64_MAX,
    });
  } finally {
    await admin.end();
  }

  const restricted = new Client({
    connectionString: runtimeUrl(database.connectionString, roleName, password),
  });
  await restricted.connect();
  try {
    await restricted.query("begin");
    await restricted.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
    const visible = await restricted.query(
      "select tenant_id, session_id, nonce_hash from realtime_ticket_replay_claims",
    );
    assert.deepEqual(visible.rows, [{
      tenant_id: TENANT_A,
      session_id: SESSION_A,
      nonce_hash: "c".repeat(64),
    }]);
    await assert.rejects(
      insertClaim(restricted, {
        tenantId: tenantB.tenantId,
        sessionId: tenantB.sessionId,
        nonceHash: "e".repeat(64),
        expiresAtUnixSeconds: U64_MAX,
      }),
      /row-level security|policy/i,
    );
    await restricted.query("rollback");
  } finally {
    await restricted.end();
  }

  const cascade = new Client({ connectionString: database.connectionString });
  await cascade.connect();
  try {
    await cascade.query("delete from recitation_sessions where id = $1", [tenantB.sessionId]);
    const remaining = await cascade.query(
      "select count(*)::int as count from realtime_ticket_replay_claims where session_id = $1",
      [tenantB.sessionId],
    );
    assert.equal(remaining.rows[0].count, 0);
  } finally {
    await cascade.end();
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;

const RECOVERY_COLUMNS = [
  "capture_report_version",
  "capture_report_state",
  "capture_total_chunks",
  "capture_acknowledged_chunks",
  "capture_dropped_chunks",
  "capture_uncertain_chunks",
  "capture_stop_reason",
  "capture_reported_at",
];

function runtimeUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function seedSession(client, suffix) {
  const tenantId = `tenant-recovery-${suffix}`;
  const learnerId = `learner-recovery-${suffix}`;
  const consentId = `consent-recovery-${suffix}`;
  const sessionId = `session-recovery-${suffix}`;
  const auditId = `audit-recovery-${suffix}`;
  await client.query(
    "insert into institutions (id, name, region) values ($1, 'Recovery tenant', 'test')",
    [tenantId],
  );
  await client.query(
    `insert into users (id, tenant_id, display_name, role, language)
     values ($1, $2, 'Recovery learner', 'learner', 'ckb')`,
    [learnerId, tenantId],
  );
  await client.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     values ($1, $2, $3, 'recovery.test', 'recitation_session', $4)`,
    [auditId, tenantId, learnerId, sessionId],
  );
  await client.query(
    `insert into consent_records
       (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
     values ($1, $2, $3, 'teacher-review', false, true, true, 'recovery-v1', $4)`,
    [consentId, tenantId, learnerId, auditId],
  );
  await client.query(
    `insert into recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        external_processing_allowed, confidence, review_status, started_at, latency_ms,
        consent_record_id, audit_event_id)
     values ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
             'recovery-checksum', 'model-v0.3', 'guided-recite', true, 0, 'draft',
             now(), 0, $4, $5)`,
    [sessionId, tenantId, learnerId, consentId, auditId],
  );
  return { tenantId, learnerId, sessionId };
}

const REPORT_ASSIGNMENT = `
  capture_report_version = 1,
  capture_report_state = 'complete',
  capture_total_chunks = 2,
  capture_acknowledged_chunks = 2,
  capture_dropped_chunks = 0,
  capture_uncertain_chunks = 0,
  capture_stop_reason = 'completed',
  capture_reported_at = clock_timestamp()`;

test("0038 checksum-locks constrained recovery truth onto the existing forced-RLS session", async (t) => {
  const plan = await loadMigrationPlan();
  assert.equal(plan.length, 37);
  assert.deepEqual(
    { id: plan.at(-1)?.id, filename: plan.at(-1)?.filename, checksum: plan.at(-1)?.checksum },
    {
      id: "0038",
      filename: "0038_realtime_recovery_report.sql",
      checksum: "9d50e65fb63284ac2543e1b8224080f0de27a21cf0a5c3332aaf30b696a06d66",
    },
  );

  const database = await createTestDatabase(t, "realtime_recovery_schema");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });
  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const columns = await client.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'recitation_sessions'
          and column_name = any($1)
        order by ordinal_position`,
      [RECOVERY_COLUMNS],
    );
    assert.deepEqual(columns.rows.map(({ column_name }) => column_name), RECOVERY_COLUMNS);
    assert.ok(columns.rows.every(({ is_nullable }) => is_nullable === "YES"));
    assert.ok(columns.rows.every(({ column_default }) => column_default === null));
    assert.equal(
      columns.rows.some(({ column_name }) => /audio|ticket|nonce|token|transcript|tenant|learner/i.test(column_name)),
      false,
    );

    const constraints = await client.query(
      `select conname, pg_get_constraintdef(oid, true) as definition
         from pg_constraint
        where conrelid = 'recitation_sessions'::regclass
          and conname like 'recitation_sessions_capture_%'
        order by conname`,
    );
    const definitions = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    assert.match(definitions.get("recitation_sessions_capture_all_or_none_check") ?? "", /capture_report_version IS NULL.*capture_reported_at IS NULL.*OR.*IS NOT NULL/is);
    assert.match(
      definitions.get("recitation_sessions_capture_accounting_check") ?? "",
      /capture_total_chunks = \(?capture_acknowledged_chunks \+ capture_dropped_chunks \+ capture_uncertain_chunks\)?/i,
    );
    assert.match(definitions.get("recitation_sessions_capture_state_check") ?? "", /complete.*degraded/i);
    assert.match(definitions.get("recitation_sessions_capture_reason_check") ?? "", /retry-exhausted.*buffer-overflow.*ack-ambiguous.*ack-invalid.*rejected-exhausted.*drain-timeout.*device-failure/is);
    assert.match(definitions.get("recitation_sessions_capture_complete_check") ?? "", /complete.*completed.*capture_dropped_chunks = 0.*capture_uncertain_chunks = 0/is);

    const trigger = await client.query(
      `select tgname, pg_get_triggerdef(oid, true) as definition
         from pg_trigger
        where tgrelid = 'recitation_sessions'::regclass and not tgisinternal`,
    );
    assert.ok(trigger.rows.some(({ tgname, definition }) =>
      tgname === "recitation_sessions_capture_report_immutable" &&
      /BEFORE UPDATE OF capture_report_version/i.test(definition)));
  } finally {
    await client.end();
  }
});

test("recovery accounting is constrained, immutable, and tenant isolated", async (t) => {
  const database = await createTestDatabase(t, "realtime_recovery_constraints");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const left = await seedSession(admin, randomUUID());
  const right = await seedSession(admin, randomUUID());
  await admin.query(`update recitation_sessions set ${REPORT_ASSIGNMENT} where id = $1`, [left.sessionId]);
  await admin.query(
    "update recitation_sessions set capture_total_chunks = 2 where id = $1",
    [left.sessionId],
  );
  await assert.rejects(
    admin.query(
      `update recitation_sessions set capture_total_chunks = 3 where id = $1`,
      [left.sessionId],
    ),
    /immutable|capture report/i,
  );
  await assert.rejects(
    admin.query(
      `update recitation_sessions set
         capture_report_version = 1, capture_report_state = 'degraded',
         capture_total_chunks = 1, capture_acknowledged_chunks = 1,
         capture_dropped_chunks = 1, capture_uncertain_chunks = 0,
         capture_stop_reason = 'buffer-overflow', capture_reported_at = clock_timestamp()
       where id = $1`,
      [right.sessionId],
    ),
    /accounting|check/i,
  );
  await admin.end();

  const roleName = `qrai_recovery_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "realtime-recovery-migration-password";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  t.after(async () => {
    const cleanup = new Client({ connectionString: migrationTestAdminUrl() });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const restricted = new Client({
    connectionString: runtimeUrl(database.connectionString, roleName, password),
  });
  await restricted.connect();
  await restricted.query("begin");
  await restricted.query("select set_config('app.tenant_id', $1, true)", [left.tenantId]);
  const visible = await restricted.query(
    `select id, capture_report_state from recitation_sessions
      where capture_report_version is not null`,
  );
  assert.deepEqual(visible.rows, [{ id: left.sessionId, capture_report_state: "complete" }]);
  const cross = await restricted.query(
    `update recitation_sessions set ${REPORT_ASSIGNMENT} where id = $1 returning id`,
    [right.sessionId],
  );
  assert.equal(cross.rowCount, 0, "another tenant's session report was writable");
  await restricted.query("rollback");
  await restricted.end();
});

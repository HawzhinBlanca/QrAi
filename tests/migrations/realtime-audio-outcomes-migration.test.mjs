import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;

function runtimeUrl(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function seedTenantSession(client, suffix, retention = "teacher-review") {
  const tenantId = `tenant-audio-outcome-${suffix}`;
  const learnerId = `learner-audio-outcome-${suffix}`;
  const consentId = `consent-audio-outcome-${suffix}`;
  const sessionId = `session-audio-outcome-${suffix}`;
  const auditId = `audit-audio-outcome-${suffix}`;
  await client.query(
    "insert into institutions (id, name, region) values ($1, 'Audio outcome tenant', 'test')",
    [tenantId],
  );
  await client.query(
    `insert into users (id, tenant_id, display_name, role, language)
     values ($1, $2, 'Audio outcome learner', 'learner', 'ckb')`,
    [learnerId, tenantId],
  );
  await client.query(
    `insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     values ($1, $2, $3, 'audio.outcome.test', 'recitation_session', $4)`,
    [auditId, tenantId, learnerId, sessionId],
  );
  await client.query(
    `insert into consent_records
       (id, tenant_id, user_id, audio_retention, anonymized_learning,
        external_asr_processing, guardian_approved, consent_version, audit_event_id)
     values ($1, $2, $3, $4, false, false, true, 'audio-outcome-v1', $5)`,
    [consentId, tenantId, learnerId, retention, auditId],
  );
  await client.query(
    `insert into recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        external_processing_allowed, confidence, review_status, started_at, latency_ms,
        consent_record_id, audit_event_id)
     values ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
             'audio-outcome-checksum', 'model-v0.3', 'guided-recite', false, 0, 'draft',
             now(), 0, $4, $5)`,
    [sessionId, tenantId, learnerId, consentId, auditId],
  );
  return { tenantId, learnerId, sessionId };
}

async function insertOutcome(client, identity, overrides = {}) {
  return client.query(
    `insert into realtime_audio_chunk_outcomes
       (tenant_id, session_id, chunk_id, start_ms, end_ms, sample_rate,
        initial_outcome, reason_code, repaired_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      identity.tenantId,
      identity.sessionId,
      overrides.chunkId ?? `${identity.sessionId}-ws-0000`,
      overrides.startMs ?? 0,
      overrides.endMs ?? 480,
      overrides.sampleRate ?? 16_000,
      overrides.initialOutcome ?? "accepted-lost",
      overrides.reasonCode ?? "store-failed",
      overrides.repairedAt ?? null,
    ],
  );
}

test("0037 adds one checksum-locked forced-RLS realtime audio diagnostic authority", async (t) => {
  const plan = await loadMigrationPlan();
  assert.equal(plan.length, 37);
  const outcomeMigration = plan.find(({ id }) => id === "0037");
  assert.deepEqual(
    { id: outcomeMigration?.id, filename: outcomeMigration?.filename, checksum: outcomeMigration?.checksum },
    {
      id: "0037",
      filename: "0037_realtime_audio_chunk_outcomes.sql",
      checksum: "aeb08e953468bd0a805d71a2c0b7c3c43d6fca3952e57dd8053f6398004de2fe",
    },
  );

  const database = await createTestDatabase(t, "realtime_audio_outcomes_schema");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });
  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const relation = await client.query(
      `select relrowsecurity, relforcerowsecurity
         from pg_class where oid = 'realtime_audio_chunk_outcomes'::regclass`,
    );
    assert.deepEqual(relation.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

    const columns = await client.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'realtime_audio_chunk_outcomes'
        order by ordinal_position`,
    );
    assert.deepEqual(columns.rows, [
      { column_name: "tenant_id", data_type: "text", is_nullable: "NO" },
      { column_name: "session_id", data_type: "text", is_nullable: "NO" },
      { column_name: "chunk_id", data_type: "text", is_nullable: "NO" },
      { column_name: "start_ms", data_type: "integer", is_nullable: "NO" },
      { column_name: "end_ms", data_type: "integer", is_nullable: "NO" },
      { column_name: "sample_rate", data_type: "integer", is_nullable: "NO" },
      { column_name: "initial_outcome", data_type: "text", is_nullable: "NO" },
      { column_name: "reason_code", data_type: "text", is_nullable: "NO" },
      { column_name: "first_observed_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "repaired_at", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
    assert.equal(
      columns.rows.some(({ column_name: name }) =>
        /ticket|nonce|audio_bytes|exception|trace|learner|object_key|url/i.test(name)),
      false,
    );

    const constraints = await client.query(
      `select conname, pg_get_constraintdef(oid, true) as definition
         from pg_constraint
        where conrelid = 'realtime_audio_chunk_outcomes'::regclass
        order by conname`,
    );
    const definitions = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    assert.match(definitions.get("realtime_audio_chunk_outcomes_pkey") ?? "", /PRIMARY KEY \(tenant_id, session_id, chunk_id\)/);
    assert.match(definitions.get("realtime_audio_chunk_outcomes_session_fk") ?? "", /FOREIGN KEY \(tenant_id, session_id\).*recitation_sessions\(tenant_id, id\).*ON DELETE CASCADE/i);
    assert.match(definitions.get("realtime_audio_chunk_outcomes_span_check") ?? "", /start_ms >= 0.*end_ms > start_ms/i);
    assert.match(definitions.get("realtime_audio_chunk_outcomes_sample_rate_check") ?? "", /16000.*24000.*48000/);
    assert.match(definitions.get("realtime_audio_chunk_outcomes_initial_check") ?? "", /accepted-lost.*stored-unindexed/);
    assert.match(definitions.get("realtime_audio_chunk_outcomes_reason_check") ?? "", /store-failed.*store-aborted.*index-failed.*index-conflict.*reconciled-orphan/);

    const observedDefault = await client.query(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'realtime_audio_chunk_outcomes'
          and column_name = 'first_observed_at'`,
    );
    assert.match(observedDefault.rows[0]?.column_default ?? "", /clock_timestamp\(\)/);

    const indexes = await client.query(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'realtime_audio_chunk_outcomes'`,
    );
    assert.ok(indexes.rows.some(({ indexname, indexdef }) =>
      indexname === "realtime_audio_chunk_outcomes_open" &&
      /\(tenant_id, initial_outcome, repaired_at, session_id, chunk_id\)/.test(indexdef)));
  } finally {
    await client.end();
  }
});

test("outcome constraints, tenant isolation, and session privacy cascade are executable", async (t) => {
  const database = await createTestDatabase(t, "realtime_audio_outcomes_rls");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const left = await seedTenantSession(admin, randomUUID());
  const right = await seedTenantSession(admin, randomUUID());
  await insertOutcome(admin, left);
  await insertOutcome(admin, right, {
    initialOutcome: "stored-unindexed",
    reasonCode: "index-failed",
  });
  await assert.rejects(insertOutcome(admin, left, { chunkId: "bad-span", startMs: -1 }), /span|check/i);
  await assert.rejects(insertOutcome(admin, left, { chunkId: "bad-rate", sampleRate: 44_100 }), /sample_rate|check/i);
  await assert.rejects(insertOutcome(admin, left, { chunkId: "bad-outcome", initialOutcome: "indexed" }), /initial|check/i);
  await assert.rejects(insertOutcome(admin, left, { chunkId: "bad-reason", reasonCode: "raw exception" }), /reason|check/i);
  await admin.end();

  const roleName = `qrai_audio_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "audio-outcome-migration-password";
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
    "select tenant_id, session_id, initial_outcome from realtime_audio_chunk_outcomes",
  );
  assert.deepEqual(visible.rows, [{
    tenant_id: left.tenantId,
    session_id: left.sessionId,
    initial_outcome: "accepted-lost",
  }]);
  await assert.rejects(
    insertOutcome(restricted, right, { chunkId: "cross-tenant" }),
    /row-level security|policy/i,
  );
  await restricted.query("rollback");
  await restricted.end();

  const cascade = new Client({ connectionString: database.connectionString });
  await cascade.connect();
  await cascade.query("delete from recitation_sessions where id = $1", [left.sessionId]);
  const remaining = await cascade.query(
    "select count(*)::int as count from realtime_audio_chunk_outcomes where session_id = $1",
    [left.sessionId],
  );
  assert.equal(remaining.rows[0].count, 0);
  await cascade.end();
});

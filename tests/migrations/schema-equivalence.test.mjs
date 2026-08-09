import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  computeSchemaFingerprint,
  loadMigrationPlan,
  migrateDatabase,
} from "../../server/scripts/migrate.mjs";
import { createTestDatabase } from "./lib/postgres.mjs";

const { Client } = pg;

async function applyLegacy(connectionString, migrations) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const migration of migrations) {
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

async function fingerprint(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await computeSchemaFingerprint(client);
  } finally {
    await client.end();
  }
}

async function ledger(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return (await client.query("select id, checksum, adopted from schema_migrations order by id")).rows;
  } finally {
    await client.end();
  }
}

test("fresh, legacy-0021 upgrade, and legacy-0027 adoption converge exactly", async (t) => {
  const fresh = await createTestDatabase(t, "schema_fresh");
  const upgraded = await createTestDatabase(t, "schema_upgrade");
  const adopted = await createTestDatabase(t, "schema_adopted");
  if (!fresh || !upgraded || !adopted) return;

  const plan = await loadMigrationPlan();
  const through0021 = plan.filter(({ id }) => id <= "0021");
  const through0027 = plan.filter(({ id }) => id <= "0027");
  assert.equal(through0021.length, 20);
  assert.equal(through0027.length, 26);
  assert.equal(plan.length, 37);

  const freshResult = await migrateDatabase({ connectionString: fresh.connectionString });
  assert.equal(freshResult.applied, 37);
  assert.equal(freshResult.adopted, 0);

  await applyLegacy(upgraded.connectionString, through0021);
  const upgradedResult = await migrateDatabase({ connectionString: upgraded.connectionString });
  assert.equal(upgradedResult.adopted, 20);
  assert.equal(upgradedResult.applied, 17);

  await applyLegacy(adopted.connectionString, through0027);
  const adoptedResult = await migrateDatabase({ connectionString: adopted.connectionString });
  assert.equal(adoptedResult.adopted, 26);
  assert.equal(adoptedResult.applied, 11);

  const fingerprints = await Promise.all([
    fingerprint(fresh.connectionString),
    fingerprint(upgraded.connectionString),
    fingerprint(adopted.connectionString),
  ]);
  assert.equal(fingerprints[0].hash, fingerprints[1].hash);
  assert.equal(fingerprints[0].hash, fingerprints[2].hash);
  assert.deepEqual(fingerprints[0].document, fingerprints[1].document);
  assert.deepEqual(fingerprints[0].document, fingerprints[2].document);

  const ledgers = await Promise.all([
    ledger(fresh.connectionString),
    ledger(upgraded.connectionString),
    ledger(adopted.connectionString),
  ]);
  assert.deepEqual(ledgers[0].map(({ id, checksum }) => ({ id, checksum })), plan.map(({ id, checksum }) => ({ id, checksum })));
  assert.deepEqual(ledgers[1].map(({ id, checksum }) => ({ id, checksum })), plan.map(({ id, checksum }) => ({ id, checksum })));
  assert.deepEqual(ledgers[2].map(({ id, checksum }) => ({ id, checksum })), plan.map(({ id, checksum }) => ({ id, checksum })));
  assert.equal(ledgers[1].filter(({ adopted: value }) => value).length, 20);
  assert.equal(ledgers[2].filter(({ adopted: value }) => value).length, 26);
});

test("0029 selects the real runtime model and requires a tenant/session-bound run for new server evidence", async (t) => {
  const database = await createTestDatabase(t, "provenance_schema");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const selected = await client.query(
      "select id, version, status from model_versions where kind = 'alignment' and runtime_selected order by id",
    );
    assert.deepEqual(selected.rows, [{
      id: "quran-constrained-levenshtein@1",
      version: "1",
      status: "draft",
    }]);

    const constraints = await client.query(
      `select conname, convalidated, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'word_alignments'::regclass
          and conname in ('word_alignments_run_tenant_session_fk', 'word_alignments_server_derived_has_run')
        order by conname`,
    );
    assert.equal(constraints.rows.length, 2);
    assert.match(constraints.rows[0].definition, /FOREIGN KEY \(alignment_run_id, tenant_id, session_id\)/);
    assert.equal(constraints.rows[1].convalidated, false, "historical rows must not receive invented run ids");

    await assert.rejects(
      client.query(
        `insert into word_alignments
           (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
            model_version_id, audit_event_id, transcript_source)
         values ('0029-missing-run', 'hikmah-pilot-erbil', 'session-seed-fatihah-1', '1:1:1',
                 'fixture', 0, 1, 1, 'matched', 'quran-constrained-levenshtein@1',
                 'audit-seed-align-1', 'server-derived')`,
      ),
      /word_alignments_server_derived_has_run/,
    );

    await client.query(
      `insert into alignment_runs
         (id, tenant_id, session_id, model_version_id, dataset_version, latency_ms, evidence_ids,
          consent_snapshot, audit_event_id, transcript_source, model_attribution)
       values ('0029-run', 'hikmah-pilot-erbil', 'session-seed-fatihah-1',
               'quran-constrained-levenshtein@1', 'declared-test-dataset', 1, '["evidence-1"]',
               '{}', 'audit-seed-align-1', 'server-derived', '{}')`,
    );
    await client.query(
      `insert into word_alignments
         (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
          model_version_id, audit_event_id, transcript_source, alignment_run_id)
       values ('0029-linked-run', 'hikmah-pilot-erbil', 'session-seed-fatihah-1', '1:1:1',
               'fixture', 0, 1, 1, 'matched', 'quran-constrained-levenshtein@1',
               'audit-seed-align-1', 'server-derived', '0029-run')`,
    );
  } finally {
    await client.end();
  }
});

test("0030 makes text rules instructional and reserves confidence for acoustic findings", async (t) => {
  const database = await createTestDatabase(t, "tajweed_instruction_boundary");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const historical = await client.query(
      `select count(*)::int as count
         from tajweed_findings
        where analysis_basis = 'text-rule' and confidence is null`,
    );
    assert.ok(historical.rows[0].count > 0, "seeded canonical rules were not reclassified");
    const confidenceConstraint = await client.query(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'tajweed_findings'::regclass
          and conname = 'tajweed_findings_basis_confidence_check'`,
    );
    assert.match(confidenceConstraint.rows[0].definition, /analysis_basis = 'acoustic'.*confidence IS NOT NULL/i);

    await assert.rejects(
      client.query(
        `insert into tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id, analysis_basis)
         values ('0030-text-with-confidence', 'hikmah-pilot-erbil', 'align-seed-1', 'fixture',
                 'practice', 0.9, 'fixture', 'ai-suggested', '[]', 'tajweed-v0.1',
                 'audit-seed-align-1', 'text-rule')`,
      ),
      /tajweed_findings_basis_confidence_check/,
    );
    await assert.rejects(
      client.query(
        `insert into tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id, analysis_basis)
         values ('0030-acoustic-without-confidence', 'hikmah-pilot-erbil', 'align-seed-1',
                 'fixture', 'practice', null, 'fixture', 'ai-suggested', '[]', 'tajweed-v0.1',
                 'audit-seed-align-1', 'acoustic')`,
      ),
      /release-eligible evaluation evidence|tajweed_findings_basis_confidence_check/,
    );
  } finally {
    await client.end();
  }
});

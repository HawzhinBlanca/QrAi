import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { loadMigrationPlan, migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import { createTestDatabase, migrationTestAdminUrl } from "./lib/postgres.mjs";

const { Client } = pg;

const digest = (character) => `sha256:${character.repeat(64)}`;
const fixtureEvidenceId = "fixture-db-evidence-v1";

async function insertDeclaredFixtureEvidence(client, overrides = {}) {
  const values = {
    id: "0031-fixture-eval",
    tenantId: "hikmah-pilot-erbil",
    evidenceId: fixtureEvidenceId,
    evidencePayloadSha256: digest("1"),
    evidenceEligibility: "fixture-regression",
    releaseEligible: false,
    passed: false,
    modelVersion: "model-v0.3",
    ...overrides,
  };
  await client.query(
    `insert into eval_runs
       (id, tenant_id, model_version_id, dataset_version, metrics, word_alignment_f1, tajweed_f1,
        false_positive_rate, teacher_agreement_rate, unsourced_learner_outputs, passed,
        evaluation_task, evidence_id, evidence_kind, evidence_eligibility, release_eligible,
        evidence_payload, evidence_payload_sha256, candidate_id, model_artifact_sha256,
        dataset_manifest_sha256, split_manifest_sha256, split_id, evaluator_version,
        evaluator_source_sha256, evaluator_protocol_sha256, raw_row_manifest_sha256,
        raw_results_sha256, calibrator_id, calibrator_artifact_sha256, signer_key_id,
        signature_algorithm, signature_base64url, signed_at, evaluation_counts, slice_metrics)
     values
       ($1, $2, $20, 'declared-fixture-v1', '{}', 0, 0, 1, 0, 0, $19,
        'acoustic-tajweed', $3, 'row-level-computed-evaluation', $17, $18,
        $4, $5, 'fixture-candidate', $6, $7, $8, 'held-out', 'fixture-evaluator-v1',
        $9, $10, $11, $12, 'fixture-calibrator', $13, 'test-only-ephemeral',
        'Ed25519', $14, '2026-08-07T00:00:00Z', $15, $16)`,
    [
      values.id,
      values.tenantId,
      values.evidenceId,
      JSON.stringify({ declaredFixture: true, evidenceId: values.evidenceId }),
      values.evidencePayloadSha256,
      digest("2"),
      digest("3"),
      digest("4"),
      digest("5"),
      digest("6"),
      digest("7"),
      digest("8"),
      digest("9"),
      "A".repeat(86),
      JSON.stringify({ negativeCount: 1, positiveCount: 1, reciterCount: 2, rowCount: 2 }),
      JSON.stringify([{ declaredFixture: true, sliceId: "fixture-slice" }]),
      values.evidenceEligibility,
      values.releaseEligible,
      values.passed,
      values.modelVersion,
    ],
  );
}

test("0033 preserves historical rows but requires release-eligible provenance for new acoustic findings", async (t) => {
  const database = await createTestDatabase(t, "acoustic_finding_authority");
  if (!database) return;
  const plan = await loadMigrationPlan();
  const migration = plan.find(({ id }) => id === "0033");
  assert.ok(migration, "0033 acoustic finding authority migration must exist");

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    for (const item of plan.filter(({ id }) => id < "0033")) await client.query(item.sql);
    await client.query(
      `insert into tajweed_findings
         (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
          source_refs, model_version_id, audit_event_id, analysis_basis)
       values ('0033-historical-acoustic', 'hikmah-pilot-erbil', 'align-seed-1', 'fixture',
               'practice', 0.5, 'historical fixture', 'ai-suggested', '[]', 'model-v0.3',
               'audit-seed-align-1', 'acoustic')`,
    );

    await client.query(migration.sql);
    assert.equal(
      (
        await client.query(
          "select evaluation_evidence_id from tajweed_findings where id = '0033-historical-acoustic'",
        )
      ).rows[0].evaluation_evidence_id,
      null,
    );
    await client.query(
      "update tajweed_findings set review_status = 'teacher-review-required' where id = '0033-historical-acoustic'",
    );

    await assert.rejects(
      client.query(
        `insert into tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id, analysis_basis)
         values ('0033-new-without-evidence', 'hikmah-pilot-erbil', 'align-seed-1', 'fixture',
                 'practice', 0.5, 'new fixture', 'ai-suggested', '[]', 'model-v0.3',
                 'audit-seed-align-1', 'acoustic')`,
      ),
      /release-eligible|provenance/i,
    );

    await insertDeclaredFixtureEvidence(client, {
      id: "0033-ineligible-eval",
      evidenceId: "0033-ineligible-evidence",
      evidencePayloadSha256: digest("a"),
    });
    const insertFinding = (id, evidenceId, evidenceSha256) =>
      client.query(
        `insert into tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id, analysis_basis,
            evaluation_evidence_id, evaluation_evidence_sha256, model_artifact_sha256,
            acoustic_dataset_version, acoustic_dataset_manifest_sha256, calibrator_id,
            calibrator_artifact_sha256)
         values ($1, 'hikmah-pilot-erbil', 'align-seed-1', 'fixture', 'practice', 0.5,
                 'declared database fixture', 'ai-suggested', '[]', 'model-v0.3',
                 'audit-seed-align-1', 'acoustic', $2, $3, $4, 'declared-fixture-v1', $5,
                 'fixture-calibrator', $6)`,
        [id, evidenceId, evidenceSha256, digest("2"), digest("3"), digest("9")],
      );
    await assert.rejects(
      insertFinding("0033-ineligible-finding", "0033-ineligible-evidence", digest("a")),
      /release-eligible/i,
    );

    await insertDeclaredFixtureEvidence(client, {
      id: "0033-release-labelled-eval",
      evidenceId: "0033-release-labelled-evidence",
      evidencePayloadSha256: digest("b"),
      evidenceEligibility: "release-candidate",
      releaseEligible: true,
      passed: true,
    });
    await insertFinding(
      "0033-release-linked-finding",
      "0033-release-labelled-evidence",
      digest("b"),
    );
  } finally {
    await client.end();
  }
});

test("0032 demotes every historical model claim that lacks production-trusted evidence", async (t) => {
  const database = await createTestDatabase(t, "unevidenced_release_claims");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const claims = await client.query(
      `select id, status from model_versions
       where status in ('eval-passed', 'released') order by id`,
    );
    assert.deepEqual(claims.rows, []);

    const historical = await client.query(
      "select id, status from model_versions where id in ('model-v0.3', 'tajweed-v0.1') order by id",
    );
    assert.deepEqual(historical.rows, [
      { id: "model-v0.3", status: "draft" },
      { id: "tajweed-v0.1", status: "draft" },
    ]);
  } finally {
    await client.end();
  }
});

test("0031 stores signed evaluation authority without promoting historical aggregate rows", async (t) => {
  const database = await createTestDatabase(t, "eval_evidence_authority");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const historical = await client.query(
      `select evidence_kind, evidence_eligibility, release_eligible, evidence_id,
              evidence_payload, signer_key_id
         from eval_runs where id = 'eval-v0.3'`,
    );
    assert.deepEqual(historical.rows[0], {
      evidence_kind: "legacy-aggregate",
      evidence_eligibility: "fixture-regression",
      release_eligible: false,
      evidence_id: null,
      evidence_payload: null,
      signer_key_id: null,
    });

    await insertDeclaredFixtureEvidence(client);
    const stored = await client.query(
      `select evidence_id, evidence_kind, evidence_eligibility, release_eligible,
              evidence_payload, evidence_payload_sha256, candidate_id, model_artifact_sha256,
              dataset_manifest_sha256, split_manifest_sha256, split_id, evaluator_version,
              evaluator_source_sha256, evaluator_protocol_sha256, raw_row_manifest_sha256,
              raw_results_sha256, calibrator_id, calibrator_artifact_sha256, signer_key_id,
              signature_algorithm, signature_base64url, evaluation_counts, slice_metrics
         from eval_runs where id = '0031-fixture-eval'`,
    );
    assert.equal(stored.rows[0].evidence_id, fixtureEvidenceId);
    assert.equal(stored.rows[0].evidence_kind, "row-level-computed-evaluation");
    assert.equal(stored.rows[0].evidence_eligibility, "fixture-regression");
    assert.equal(stored.rows[0].release_eligible, false);
    assert.deepEqual(stored.rows[0].evidence_payload, {
      declaredFixture: true,
      evidenceId: fixtureEvidenceId,
    });
    assert.deepEqual(stored.rows[0].evaluation_counts, {
      negativeCount: 1,
      positiveCount: 1,
      reciterCount: 2,
      rowCount: 2,
    });
    assert.deepEqual(stored.rows[0].slice_metrics, [
      { declaredFixture: true, sliceId: "fixture-slice" },
    ]);
    for (const key of [
      "evidence_payload_sha256",
      "model_artifact_sha256",
      "dataset_manifest_sha256",
      "split_manifest_sha256",
      "evaluator_source_sha256",
      "evaluator_protocol_sha256",
      "raw_row_manifest_sha256",
      "raw_results_sha256",
      "calibrator_artifact_sha256",
    ]) {
      assert.match(stored.rows[0][key], /^sha256:[a-f0-9]{64}$/, key);
    }
    assert.equal(stored.rows[0].signature_algorithm, "Ed25519");
    assert.equal(stored.rows[0].signature_base64url.length, 86);

    await assert.rejects(
      client.query(
        "update eval_runs set evidence_payload = '{\"tampered\":true}' where id = '0031-fixture-eval'",
      ),
      /evaluation evidence is immutable/i,
    );
    await client.query("update eval_runs set passed = false where id = '0031-fixture-eval'");
  } finally {
    await client.end();
  }
});

test("0031 rejects partial, malformed, or boolean-only evaluation authority", async (t) => {
  const database = await createTestDatabase(t, "eval_evidence_constraints");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    await assert.rejects(
      client.query(
        `insert into eval_runs
           (id, tenant_id, model_version_id, dataset_version, metrics, passed, release_eligible)
         values ('0031-boolean-only', 'hikmah-pilot-erbil', 'model-v0.3', 'fixture', '{}', true, true)`,
      ),
      /eval_runs_release_eligibility_check/,
    );
    await assert.rejects(
      client.query(
        `insert into eval_runs
           (id, tenant_id, model_version_id, dataset_version, metrics, passed,
            evidence_kind, evidence_payload)
         values ('0031-partial', 'hikmah-pilot-erbil', 'model-v0.3', 'fixture', '{}', false,
                 'row-level-computed-evaluation', '{"declaredFixture":true}')`,
      ),
      /eval_runs_evidence_completeness_check/,
    );
    await assert.rejects(
      insertDeclaredFixtureEvidence(client, {
        id: "0031-bad-digest",
        evidenceId: "fixture-bad-digest",
        evidencePayloadSha256: "mutable-alias",
      }),
      /eval_runs_evidence_payload_sha256_check/,
    );
  } finally {
    await client.end();
  }
});

test("0031 binds complete finding provenance to the exact same-tenant evidence row", async (t) => {
  const database = await createTestDatabase(t, "finding_evidence_fk");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    await insertDeclaredFixtureEvidence(client, {
      evidenceEligibility: "release-candidate",
      releaseEligible: true,
      passed: true,
      modelVersion: "tajweed-v0.1",
    });
    const insertFinding = (id, evidenceSha256 = digest("1"), calibratorId = "fixture-calibrator") =>
      client.query(
        `insert into tajweed_findings
           (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
            source_refs, model_version_id, audit_event_id, analysis_basis,
            evaluation_evidence_id, evaluation_evidence_sha256, model_artifact_sha256,
            acoustic_dataset_version, acoustic_dataset_manifest_sha256, calibrator_id,
            calibrator_artifact_sha256)
         values ($1, 'hikmah-pilot-erbil', 'align-seed-1', 'declared-fixture', 'practice', 0.5,
                 'declared fixture only', 'ai-suggested', '[]', 'tajweed-v0.1',
                 'audit-seed-align-1', 'acoustic', $2, $3, $4, 'declared-fixture-v1', $5, $6, $7)`,
        [id, fixtureEvidenceId, evidenceSha256, digest("2"), digest("3"), calibratorId, digest("9")],
      );

    await insertFinding("0031-linked-finding");
    await assert.rejects(
      insertFinding("0031-wrong-evidence-digest", digest("f")),
      /does not match release-eligible|tajweed_findings_evidence_attribution_fk/,
    );
    await assert.rejects(
      insertFinding("0031-partial-evidence", digest("1"), null),
      /does not match release-eligible|tajweed_findings_evidence_attribution_completeness_check/,
    );
    await assert.rejects(
      client.query(
        "update tajweed_findings set model_artifact_sha256 = $1 where id = '0031-linked-finding'",
        [digest("f")],
      ),
      /tajweed finding provenance is immutable/i,
    );

    const historical = await client.query(
      `select evaluation_evidence_id, evaluation_evidence_sha256, model_artifact_sha256,
              acoustic_dataset_version, acoustic_dataset_manifest_sha256, calibrator_id,
              calibrator_artifact_sha256
         from tajweed_findings where id = 'finding-seed-1'`,
    );
    assert.deepEqual(historical.rows[0], {
      evaluation_evidence_id: null,
      evaluation_evidence_sha256: null,
      model_artifact_sha256: null,
      acoustic_dataset_version: null,
      acoustic_dataset_manifest_sha256: null,
      calibrator_id: null,
      calibrator_artifact_sha256: null,
    });
  } finally {
    await client.end();
  }
});

test("0031 evidence remains tenant-isolated under the restricted runtime role", async (t) => {
  const database = await createTestDatabase(t, "eval_evidence_rls");
  if (!database) return;
  const roleName = `qrai_eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "declared-test-password";
  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  await migrateDatabase({ connectionString: database.connectionString });
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  await insertDeclaredFixtureEvidence(admin);
  await admin.query(
    "insert into institutions (id, name, region) values ('0031-other-tenant', 'Fixture', 'test')",
  );
  await admin.query(
    `insert into eval_runs
       (id, tenant_id, model_version_id, dataset_version, metrics, passed, evaluation_task,
        evidence_id, evidence_kind, evidence_eligibility, release_eligible, evidence_payload,
        evidence_payload_sha256, candidate_id, model_artifact_sha256, dataset_manifest_sha256,
        split_manifest_sha256, split_id, evaluator_version, evaluator_source_sha256,
        evaluator_protocol_sha256, raw_row_manifest_sha256, raw_results_sha256, calibrator_id,
        calibrator_artifact_sha256, signer_key_id, signature_algorithm, signature_base64url,
        signed_at, evaluation_counts, slice_metrics)
     select '0031-other-eval', '0031-other-tenant', model_version_id, dataset_version, metrics, false,
            evaluation_task, evidence_id, evidence_kind, evidence_eligibility, release_eligible,
            evidence_payload, evidence_payload_sha256, candidate_id, model_artifact_sha256,
            dataset_manifest_sha256, split_manifest_sha256, split_id, evaluator_version,
            evaluator_source_sha256, evaluator_protocol_sha256, raw_row_manifest_sha256,
            raw_results_sha256, calibrator_id, calibrator_artifact_sha256, signer_key_id,
            signature_algorithm, signature_base64url, signed_at, evaluation_counts, slice_metrics
       from eval_runs where id = '0031-fixture-eval'`,
  );
  await admin.end();

  const restrictedUrl = new URL(database.connectionString);
  restrictedUrl.username = roleName;
  restrictedUrl.password = password;
  const restricted = new Client({ connectionString: restrictedUrl.toString() });
  await restricted.connect();
  try {
    await restricted.query("begin");
    await restricted.query("select set_config('app.tenant_id', $1, true)", ["hikmah-pilot-erbil"]);
    const visible = await restricted.query(
      "select id from eval_runs where evidence_id = $1 order by id",
      [fixtureEvidenceId],
    );
    assert.deepEqual(visible.rows, [{ id: "0031-fixture-eval" }]);
    await assert.rejects(
      restricted.query(
        `insert into eval_runs
           (id, tenant_id, model_version_id, dataset_version, metrics, passed)
         values ('0031-cross-tenant-write', '0031-other-tenant', 'model-v0.3', 'fixture', '{}', false)`,
      ),
      /row-level security/i,
    );
    await restricted.query("rollback");
  } finally {
    await restricted.end();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  loadMigrationPlan,
  migrateDatabase,
  sha256,
} from "../../server/scripts/migrate.mjs";
import { createTestDatabase } from "./lib/postgres.mjs";

const { Client } = pg;

const expectedHistoricalChecksums = new Map(Object.entries({
  "0001_core_schema.sql": "6df6b28b3dcc278299518b806e35a1e99b698a51f215bb223433a487ad216707",
  "0002_seed_fatihah.sql": "28d65575328adc791e190bde12af867b86f832a08afc7054cf9034ea581b3b48",
  "0003_tenant_rls.sql": "c29620df2dbeda19f5284c679fbbb22c8d53ded507a468bd6783e87815f1c26a",
  "0004_add_password_hash.sql": "6f615d0a77e094478878a914e14d3617e43d6874b97925bb0aad38bb300ee299", // gitleaks:allow -- immutable migration content checksum, not a credential
  "0005_learner_progress.sql": "1c3b11a53369666eff0bb3241f16387b7a56c3065dfeb3770c55691cb8161aee",
  "0006_seed_internal.sql": "8627a744ec81e1b3db002ec20700f2e58f215ba7ea856b1ea1758ce671b23fcf",
  "0007_seed_surah_names.sql": "ee8368b5cb613288603318b45993a14b7623cb7a785c588be0a9352f85c18727",
  "0008_session_language.sql": "269a19cc6a662095272ea6a25f679a02d023061e897da2694b22d83eefcb9f34",
  "0009_learner_progress_rls.sql": "1acb07661ecf402162377ee592564a75f36de0a5fd74c14336ed68d1a826f774",
  "0010_review_status_check.sql": "5f40448baf397cf5fdec5b8acc3a6bf9fd326ef1d52b0d09f174b1bc6da6684f",
  "0011_teacher_review_required_status.sql": "fcde646b9539d904eb5698659d7d9fe32852d5e99d2dfe9e498da6f4cca82634",
  "0012_superuser_only_rls_bypass.sql": "a5a2f71f49376f2c53fc0aeee3dbb368bec6c295c7901509976051d34c139b8e",
  "0013_unique_email_per_tenant.sql": "a08f23953b6edca35aa8eab79fcfba9279e951aebbcfff62acb54dc555b1f184",
  "0015_teacher_review_scholar_approval_indexes.sql": "12314c38223770bf49774328488a8cc435f37f94d21eaeeb4d611dbfc3ad4b4c",
  "0016_missing_tenant_indexes.sql": "b3cd72bc5ac0ac26cc8ababd96322edb6ccada44884c2daef2493f7d5da1f0fd",
  "0017_eval_runs_index.sql": "1e8a8670f16504359d89c0b57e45f59714085da2370c2f5deeb094e6236824a4",
  "0018_agent_run_learner_id.sql": "e19250e4644256ca348a40b4cb07ef4e4e72a1bf44614c8dbb9b9516917d5f3b",
  "0019_recitation_and_findings_sort_indexes.sql": "3948d6250d4195f3670d8c38011e7a4e495f3bee97ed183d54d7d2b393e779b3",
  "0020_language_check.sql": "f9e840d0734a01e16ac7b61b11e4a65166006b233b1611f685565b2533bb396a",
  "0021_pilot_identity.sql": "8ee6a5da31f3b3532d17a7c9b75496c88cb55ae1ae4eecdc2ce93cd9907f4120",
  "0022_session_lost_chunks.sql": "d058a8b7819a7b9226ef22f39ea8f6c06e00fdd5bfb281be49c8a90ffafe0f72",
  "0023_alignment_transcript_source.sql": "c1c646cbabb560c6c8e61a9ce03499ef3f47bda2dceec673081c08d8c8158e58",
  "0024_teacher_review_survives_realignment.sql": "dc13feb3afb0ba4f01093da1e542ce3d930c0a8b3bbe95bc4826ed736eee2343",
  "0025_tajweed_analysis_basis.sql": "97090f8e251457183909f0012ac9f0c1fba794e8fe7a5b3ef2940950b495c487",
  "0026_alignment_span_check.sql": "6f832d392f8b5efad9f991a0de6b93d467cca6f37113aa55eb5cadb84f2da405",
  "0027_unevidenced_model_claim.sql": "2541f0bd4311fd2a9b58bad0661dc829a526cdc5355cbc793e6adfac397b5924",
}));

/** @param {string} directory
 * @param {Array<[string, string]>} definitions
 */
async function writePlan(directory, definitions) {
  const migrations = await Promise.all(
    definitions.map(async ([filename, sql]) => {
      await writeFile(join(directory, filename), sql);
      return {
        id: filename.slice(0, 4),
        filename,
        sha256: sha256(Buffer.from(sql)),
      };
    }),
  );
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "qrai-migrations/v1", migrations }, null, 2)}\n`,
  );
}

test("all 26 historical migrations remain pinned before additive migrations", async () => {
  const plan = await loadMigrationPlan();
  const historicalPlan = plan.slice(0, expectedHistoricalChecksums.size);
  assert.equal(plan.length, 34);
  assert.deepEqual(
    historicalPlan.map(({ id }) => id),
    [...expectedHistoricalChecksums.keys()].map((name) => name.slice(0, 4)),
  );
  for (const migration of historicalPlan) {
    assert.equal(migration.checksum, expectedHistoricalChecksums.get(migration.filename), migration.filename);
  }
  assert.deepEqual(
    plan.slice(expectedHistoricalChecksums.size).map(({ id, filename, checksum }) => ({
      id,
      filename,
      checksum,
    })),
    [
      {
        id: "0028",
        filename: "0028_canonical_quran_source_id.sql",
        checksum: "6d8259e56caba281c7ee58a1879fffc00a0e5212db9db3fe0be72ee058e9dd7e",
      },
      {
        id: "0029",
        filename: "0029_alignment_provenance_round_trip.sql",
        checksum: "a433d90e84d1aee09c1af506f77b9b018d96eabb32e40bd122f619e3c5deb726",
      },
      {
        id: "0030",
        filename: "0030_tajweed_instruction_performance_boundary.sql",
        checksum: "a004438c2fb7abffa0a4f9ec4ed394b222033a6baacae90443e1a423fb5ea978",
      },
      {
        id: "0031",
        filename: "0031_evaluation_evidence_authority.sql",
        checksum: "e03bbbc6a88b148d7e7cafe260788a9bc11c6a7445d84af89dae9e1aff9c7422",
      },
      {
        id: "0032",
        filename: "0032_demote_untrusted_model_claims.sql",
        checksum: "0a596631f8f1fc42a581f1a52add08dc3b45c870f165e337a669e9ce4ea5ec9f",
      },
      {
        id: "0033",
        filename: "0033_acoustic_finding_evidence_authority.sql",
        checksum: "a6e20e4885185360cae09b91c26e5e0a00c70797b9e7a2a2364d28ea3efefe71",
      },
      {
        id: "0034",
        filename: "0034_background_jobs.sql",
        checksum: "e1d8e823b9c3564d6d40a8a67b09edd2db79fe5a1bbac6975874b4e26d7a61ac",
      },
      {
        id: "0035",
        filename: "0035_device_identity.sql",
        checksum: "45fac1fcb38c89ffd19a3dd6c916514b63b0eaaa31e51c277609cf609e342aa1",
      },
    ],
  );
  await assert.rejects(readFile(new URL("../../infra/sql/0001_core_schema.sql", import.meta.url)), /ENOENT/);
});

test("the advisory lock makes concurrent first boots serialize and the second run is idempotent", async (t) => {
  const database = await createTestDatabase(t, "migration_concurrency");
  if (!database) return;
  const directory = await mkdtemp(join(tmpdir(), "qrai-migrations-concurrency-"));
  await writePlan(directory, [["0001_once.sql", "select pg_sleep(0.2); create table exactly_once (id integer primary key);\n"]]);

  const results = await Promise.all([
    migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} }),
    migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} }),
  ]);
  assert.deepEqual(results.map(({ applied }) => applied).sort(), [0, 1]);
  assert.equal((await migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} })).applied, 0);
});

test("a migration and its ledger insert roll back together", async (t) => {
  const database = await createTestDatabase(t, "migration_rollback");
  if (!database) return;
  const directory = await mkdtemp(join(tmpdir(), "qrai-migrations-rollback-"));
  await writePlan(directory, [
    ["0001_control.sql", "create table control_table (id integer primary key);\n"],
    ["0002_broken.sql", "create table should_not_survive (id integer); select function_that_does_not_exist();\n"],
  ]);

  await assert.rejects(
    migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} }),
    /0002_broken\.sql/,
  );
  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  const state = await client.query(`
    select to_regclass('public.control_table') as control,
           to_regclass('public.should_not_survive') as partial,
           (select array_agg(id order by id) from schema_migrations) as applied
  `);
  await client.end();
  assert.equal(state.rows[0].control, "control_table");
  assert.equal(state.rows[0].partial, null);
  assert.deepEqual(state.rows[0].applied, ["0001"]);
});

test("database ledger rejects migration checksum drift even if the source manifest is rewritten", async (t) => {
  const database = await createTestDatabase(t, "migration_drift");
  if (!database) return;
  const directory = await mkdtemp(join(tmpdir(), "qrai-migrations-drift-"));
  const filename = "0001_pinned.sql";
  const original = "create table pinned_table (id integer primary key);\n";
  await writePlan(directory, [[filename, original]]);
  await migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} });

  const changed = `${original}-- rewritten after application\n`;
  await writePlan(directory, [[filename, changed]]);
  await assert.rejects(
    migrateDatabase({ connectionString: database.connectionString, migrationsDirectory: directory, legacyBaselines: {} }),
    /checksum drift.*0001/i,
  );
});

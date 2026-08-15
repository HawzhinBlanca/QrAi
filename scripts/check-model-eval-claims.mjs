#!/usr/bin/env node
/**
 * Refuse `eval-passed` or `released` unless exactly one signed, release-trusted evidence identity
 * clears the shared contract gate. Every tenant-visible row is considered: insertion order cannot
 * hide an older authority, and conflicting release-labelled evidence fails closed.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { modelEvalPassesReleaseGate } from "../packages/contracts/src/index.ts";
import { verifyModelEvidenceBundle } from "./model-evidence-verifier.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const productionTrustPolicy = JSON.parse(
  readFileSync(
    resolve(here, "..", "packages", "contracts", "model-evaluation-trusted-signers-v1.json"),
    "utf8",
  ),
);

/** Statuses that assert an evaluation was passed. `draft` and `blocked` claim nothing. */
const CLAIMS_EVALUATION = new Set(["eval-passed", "released"]);

function releaseLabelled(row) {
  return row.releaseEligible === true || row.evidenceEligibility === "release-candidate";
}

/**
 * Select one authority by verified identity, never by creation time.
 *
 * Ordinary fixture/research history is irrelevant. Every release-labelled row must verify and
 * clear the gate; one invalid row conflicts with every valid row. Exact copies visible through
 * multiple tenants collapse to one identity, while distinct valid identities are ambiguous.
 */
export function selectUniqueReleaseAuthority(rows, evaluateRow) {
  const candidates = rows.filter(releaseLabelled);
  if (candidates.length === 0) return { authority: null, problem: null };

  const authorities = new Map();
  const invalid = [];
  for (const row of candidates) {
    try {
      const result = evaluateRow(row);
      if (!result || typeof result.identity !== "string" || result.identity.length === 0) {
        throw new Error("evaluator returned no stable evidence identity");
      }
      if (!authorities.has(result.identity)) authorities.set(result.identity, result.authority);
    } catch (error) {
      invalid.push(`${row.id ?? "unknown-row"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (invalid.length > 0) {
    return {
      authority: null,
      problem: `invalid release-labelled evidence (${invalid.join("; ")})`,
    };
  }
  if (authorities.size !== 1) {
    return {
      authority: null,
      problem: `ambiguous release authority: ${authorities.size} distinct verified identities`,
    };
  }
  return { authority: authorities.values().next().value, problem: null };
}

/** The model's evidence problem, if its status makes a release claim. */
export function claimProblem(model, resolution) {
  if (!CLAIMS_EVALUATION.has(model.status)) return null;
  if (resolution.problem) {
    return `${model.id} claims status "${model.status}" but ${resolution.problem}`;
  }
  if (!resolution.authority) {
    return `${model.id} claims status "${model.status}" with no verified release authority`;
  }
  return null;
}

function evidenceBundleFromRow(row) {
  return {
    schemaVersion: "qrai-model-evaluation-bundle/v1",
    canonicalization: "RFC8785",
    evidence: row.evidencePayload,
    signature: {
      schemaVersion: "qrai-model-evaluation-signature/v1",
      algorithm: row.signatureAlgorithm,
      keyId: row.signerKeyId,
      payloadSha256: row.evidencePayloadSha256,
      signatureBase64Url: row.signatureBase64Url,
      signedAt: row.signedAt,
    },
  };
}

function evaluateReleaseRow(row) {
  const verification = verifyModelEvidenceBundle(
    evidenceBundleFromRow(row),
    productionTrustPolicy,
    { requireReleaseTrust: true },
  );
  if (!modelEvalPassesReleaseGate(row, verification)) {
    throw new Error("verified payload does not exactly match the database projection or release gates");
  }
  return {
    authority: {
      rowId: row.id,
      evidenceId: verification.evidenceId,
      payloadSha256: verification.payloadSha256,
      modelArtifactSha256: row.modelArtifactSha256,
    },
    identity: [
      verification.evidenceId,
      verification.payloadSha256,
      row.modelArtifactSha256,
      row.datasetManifestSha256,
      row.calibratorArtifactSha256,
    ].join("|"),
  };
}

/** Prove the status checker and authority selector can both fail before trusting a live pass. */
function selfTest() {
  const authority = { rowId: "r", evidenceId: "e" };
  const cases = [
    ["draft needs no authority", { id: "m", status: "draft" }, { authority: null, problem: null }, false],
    ["blocked needs no authority", { id: "m", status: "blocked" }, { authority: null, problem: null }, false],
    ["eval-passed accepts one authority", { id: "m", status: "eval-passed" }, { authority, problem: null }, false],
    ["released accepts one authority", { id: "m", status: "released" }, { authority, problem: null }, false],
    ["eval-passed without authority fails", { id: "m", status: "eval-passed" }, { authority: null, problem: null }, true],
    ["a conflict fails", { id: "m", status: "released" }, { authority: null, problem: "conflict" }, true],
  ];

  let failures = 0;
  for (const [name, model, resolution, shouldProblem] of cases) {
    if (Boolean(claimProblem(model, resolution)) !== shouldProblem) {
      console.error(`  ✗ self-test: ${name}`);
      failures += 1;
    }
  }
  const selected = selectUniqueReleaseAuthority(
    [
      { id: "fixture", evidenceEligibility: "fixture-regression", releaseEligible: false },
      { id: "release", evidenceEligibility: "release-candidate", releaseEligible: true },
    ],
    (row) => ({ authority: row, identity: "one" }),
  );
  if (selected.authority?.id !== "release" || selected.problem !== null) failures += 1;

  const conflict = selectUniqueReleaseAuthority(
    [
      { id: "first", evidenceEligibility: "release-candidate", releaseEligible: true },
      { id: "second", evidenceEligibility: "release-candidate", releaseEligible: true },
    ],
    (row) => ({ authority: row, identity: row.id }),
  );
  if (conflict.authority !== null || !conflict.problem) failures += 1;

  if (failures > 0) throw new Error(`check-model-eval-claims self-test FAILED (${failures})`);
  console.log(`check-model-eval-claims self-test OK (${cases.length + 2} cases)`);
}

async function readTenantEvalRows(client, tenantId) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query(
      `SELECT id,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              model_version_id AS "modelVersion", dataset_version AS "datasetVersion",
              word_alignment_f1::float8 AS "wordAlignmentF1",
              tajweed_f1::float8 AS "tajweedF1",
              false_positive_rate::float8 AS "falsePositiveRate",
              teacher_agreement_rate::float8 AS "teacherAgreementRate",
              unsourced_learner_outputs AS "unsourcedLearnerOutputs", passed,
              evaluation_task AS "evaluationTask", evidence_id AS "evidenceId",
              evidence_kind AS "evidenceKind", evidence_eligibility AS "evidenceEligibility",
              release_eligible AS "releaseEligible", evidence_payload AS "evidencePayload",
              evidence_payload_sha256 AS "evidencePayloadSha256", candidate_id AS "candidateId",
              model_artifact_sha256 AS "modelArtifactSha256",
              dataset_manifest_sha256 AS "datasetManifestSha256",
              split_manifest_sha256 AS "splitManifestSha256", split_id AS "splitId",
              evaluator_version AS "evaluatorVersion",
              evaluator_source_sha256 AS "evaluatorSourceSha256",
              evaluator_protocol_sha256 AS "evaluatorProtocolSha256",
              raw_row_manifest_sha256 AS "rawRowManifestSha256",
              raw_results_sha256 AS "rawResultsSha256", calibrator_id AS "calibratorId",
              calibrator_artifact_sha256 AS "calibratorArtifactSha256",
              signer_key_id AS "signerKeyId", signature_algorithm AS "signatureAlgorithm",
              signature_base64url AS "signatureBase64Url",
              to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "signedAt",
              evaluation_counts AS "evaluationCounts", slice_metrics AS "sliceMetrics"
       FROM eval_runs
       ORDER BY model_version_id, created_at, id`,
    );
    return rows;
  } finally {
    await client.query("ROLLBACK");
  }
}

async function checkDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to read model evaluation claims");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: models } = await client.query("SELECT id, status FROM model_versions ORDER BY id");
    if (models.length === 0) throw new Error("no model_versions rows; refusing a vacuous pass");

    const { rows: tenants } = await client.query("SELECT id FROM institutions ORDER BY id");
    if (tenants.length === 0) throw new Error("no institutions; tenant-owned eval evidence is unreadable");

    const byModel = new Map();
    for (const { id: tenantId } of tenants) {
      for (const row of await readTenantEvalRows(client, tenantId)) {
        const rows = byModel.get(row.modelVersion) ?? [];
        rows.push(row);
        byModel.set(row.modelVersion, rows);
      }
    }

    const resolutions = new Map(
      models.map((model) => [
        model.id,
        selectUniqueReleaseAuthority(byModel.get(model.id) ?? [], evaluateReleaseRow),
      ]),
    );
    const problems = models
      .map((model) => claimProblem(model, resolutions.get(model.id)))
      .filter(Boolean);
    if (problems.length > 0) {
      throw new Error(`model evaluation claims are not evidenced:\n    ${problems.join("\n    ")}`);
    }

    const claiming = models.filter((model) => CLAIMS_EVALUATION.has(model.status)).length;
    console.log(
      `✓ model eval claims: ${models.length} model version(s), ${claiming} claiming an evaluation, ` +
        `all uniquely release-evidenced (${[...byModel.values()].flat().length} visible row(s))`,
    );
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    if (process.argv.includes("--self-test")) selfTest();
    else await checkDatabase();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  canonicalizeRfc8785,
  verifyModelEvidenceBundle,
} from "../../scripts/model-evidence-verifier.mjs";
import { modelEvalPassesReleaseGate } from "../../packages/contracts/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const schemaPath = join(
  repo,
  "packages",
  "contracts",
  "schemas",
  "model-evaluation-evidence-v1.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const decisions = readFileSync(join(repo, "docs", "DECISIONS.md"), "utf8");
const verifySource = readFileSync(join(repo, "scripts", "verify.sh"), "utf8");
const productionTrustPolicy = JSON.parse(
  readFileSync(
    join(repo, "packages", "contracts", "model-evaluation-trusted-signers-v1.json"),
    "utf8",
  ),
);

const digest = `sha256:${"0".repeat(64)}`;

function uncertaintyIntervals(metrics, validReplicateCount) {
  const pointEstimates = {
    averagePrecision: metrics.averagePrecision,
    rocAuc: metrics.rocAuc,
    precision: metrics.operatingPoint.precision,
    recall: metrics.operatingPoint.recall,
    f1: metrics.operatingPoint.f1,
    falsePositiveRate: metrics.operatingPoint.falsePositiveRate,
    expectedCalibrationError: metrics.expectedCalibrationError,
    teacherAgreementRate: metrics.teacherAgreementRate,
  };
  return Object.entries(pointEstimates).map(([metric, pointEstimate]) => ({
    metric,
    pointEstimate,
    lower: Math.max(-1, pointEstimate - 0.01),
    upper: Math.min(1, pointEstimate + 0.01),
    validReplicateCount,
  }));
}

// Declared schema fixture only. These values are not model output and cannot be release evidence.
function fixtureBundle() {
  const metrics = {
    averagePrecision: 0.5,
    rocAuc: 0.5,
    operatingPoint: {
      threshold: 0.5,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      falsePositiveRate: 0.5,
    },
    expectedCalibrationError: 0.5,
    teacherAgreementRate: 0.5,
  };
  return {
    schemaVersion: "qrai-model-evaluation-bundle/v1",
    canonicalization: "RFC8785",
    evidence: {
      schemaVersion: "qrai-model-evaluation-evidence/v1",
      evidenceId: "fixture-model-evidence-schema",
      evaluationTask: "acoustic-tajweed",
      evidenceKind: "row-level-computed-evaluation",
      eligibility: "fixture-regression",
      candidate: {
        candidateId: "fixture-candidate",
        modelVersion: "fixture-model-v1",
        modelArtifactSha256: digest,
        implementationSha256: digest,
        runtimeLockSha256: digest,
        imageDigest: digest,
        registrySha256: digest,
        executionStatus: "test-only",
        licenseReviewStatus: "test-only",
      },
      dataset: {
        datasetVersion: "declared-fixture-v1",
        evidenceClass: "declared-fixture",
        manifestSha256: digest,
        splitManifestSha256: digest,
        splitId: "held-out",
        sealed: true,
        reciterDisjoint: true,
        consentStatus: "test-only",
        licenseReviewStatus: "test-only",
      },
      evaluator: {
        evaluatorVersion: "fixture-evaluator-v1",
        sourceSha256: digest,
        protocolVersion: "fixture-protocol-v1",
        protocolSha256: digest,
        protocolApprovalStatus: "test-only",
      },
      rawResults: {
        rowManifestSha256: digest,
        rowResultsSha256: digest,
      },
      counts: {
        rowCount: 2,
        positiveCount: 1,
        negativeCount: 1,
        reciterCount: 2,
        sourceBackedFindingCount: 0,
        unsourcedLearnerOutputCount: 0,
      },
      metrics,
      uncertainty: {
        method: "reciter-cluster-bootstrap",
        confidenceLevel: 0.95,
        replicateCount: 2,
        seed: 1,
        intervals: uncertaintyIntervals(metrics, 2),
      },
      slices: [
        {
          sliceId: "fixture-slice",
          dimensions: {
            languageBackground: "test-only",
            ageBand: "test-only",
            deviceClass: "test-only",
            noiseCondition: "test-only",
          },
          rowCount: 2,
          positiveCount: 1,
          negativeCount: 1,
          reciterCount: 2,
          metrics,
        },
      ],
      calibration: null,
      approvals: [],
      generatedAt: "2026-01-01T00:00:00Z",
    },
    signature: {
      schemaVersion: "qrai-model-evaluation-signature/v1",
      algorithm: "Ed25519",
      keyId: "test-only-schema-key",
      payloadSha256: digest,
      signatureBase64Url: "A".repeat(86),
      signedAt: "2026-01-01T00:00:00Z",
    },
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function signedFixture({
  keyId = "test-only-ephemeral",
  trustClass = "test-only",
  bundle = fixtureBundle(),
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(canonicalizeRfc8785(bundle.evidence), "utf8");
  bundle.signature.keyId = keyId;
  bundle.signature.payloadSha256 = sha256(payload);
  bundle.signature.signatureBase64Url = sign(null, payload, privateKey).toString("base64url");
  return {
    bundle,
    trustPolicy: {
      schemaVersion: "qrai-model-evaluation-trusted-signers/v1",
      policyId: "ephemeral-test-policy",
      keys: [
        {
          keyId,
          algorithm: "Ed25519",
          trustClass,
          status: "active",
          publicKeyJwk: publicKey.export({ format: "jwk" }),
        },
      ],
    },
  };
}

function releaseCandidateBundle() {
  const bundle = fixtureBundle();
  const evidence = bundle.evidence;
  evidence.eligibility = "release-candidate";
  evidence.candidate.executionStatus = "runnable";
  evidence.candidate.licenseReviewStatus = "approved";
  evidence.dataset.evidenceClass = "consented-held-out";
  evidence.dataset.consentStatus = "approved";
  evidence.dataset.licenseReviewStatus = "approved";
  evidence.evaluator.protocolApprovalStatus = "approved";
  evidence.metrics = {
    averagePrecision: 0.9,
    rocAuc: 0.9,
    operatingPoint: {
      threshold: 0.5,
      precision: 0.8,
      recall: 0.9,
      f1: 0.84,
      falsePositiveRate: 0.06,
    },
    expectedCalibrationError: 0.05,
    teacherAgreementRate: 0.92,
  };
  evidence.counts = {
    rowCount: 40,
    positiveCount: 20,
    negativeCount: 20,
    reciterCount: 18,
    sourceBackedFindingCount: 40,
    unsourcedLearnerOutputCount: 0,
  };
  evidence.uncertainty.replicateCount = 10_000;
  evidence.uncertainty.intervals = uncertaintyIntervals(evidence.metrics, 10_000);
  evidence.slices = ["sorani-fixture-slice", "arabic-fixture-slice"].map((sliceId) => ({
    sliceId,
    dimensions: {
      languageBackground: sliceId.startsWith("sorani") ? "kurdish-l1-sorani" : "arabic-l1",
      ageBand: "mixed-approved",
      deviceClass: "ordinary-phone",
      noiseCondition: "mixed-approved",
    },
    rowCount: 20,
    positiveCount: 10,
    negativeCount: 10,
    reciterCount: 9,
    metrics: structuredClone(evidence.metrics),
  }));
  evidence.calibration = {
    calibratorId: "fixture-calibrator",
    calibratorVersion: "fixture-calibrator-v1",
    method: "isotonic",
    artifactSha256: digest,
    sourceSha256: digest,
    fitDatasetManifestSha256: evidence.dataset.manifestSha256,
    fitSplitManifestSha256: evidence.dataset.splitManifestSha256,
  };
  evidence.approvals = ["product-owner", "quran-scholar", "privacy-legal", "data-steward"].map(
    (role) => ({
      role,
      approvalId: `fixture-${role}`,
      decision: "approved",
      artifactSha256: digest,
      approvedAt: "2026-01-01T00:00:00Z",
    }),
  );
  return bundle;
}

function evalRunFromBundle(bundle) {
  const evidence = bundle.evidence;
  return {
    modelVersion: evidence.candidate.modelVersion,
    datasetVersion: evidence.dataset.datasetVersion,
    wordAlignmentF1: 0.91,
    tajweedF1: evidence.metrics.operatingPoint.f1,
    falsePositiveRate: evidence.metrics.operatingPoint.falsePositiveRate,
    teacherAgreementRate: evidence.metrics.teacherAgreementRate,
    unsourcedLearnerOutputs: evidence.counts.unsourcedLearnerOutputCount,
    passed: true,
    evaluationTask: evidence.evaluationTask,
    evidenceId: evidence.evidenceId,
    evidenceKind: evidence.evidenceKind,
    evidenceEligibility: evidence.eligibility,
    releaseEligible: true,
    evidencePayload: evidence,
    evidencePayloadSha256: bundle.signature.payloadSha256,
    candidateId: evidence.candidate.candidateId,
    modelArtifactSha256: evidence.candidate.modelArtifactSha256,
    datasetManifestSha256: evidence.dataset.manifestSha256,
    splitManifestSha256: evidence.dataset.splitManifestSha256,
    splitId: evidence.dataset.splitId,
    evaluatorVersion: evidence.evaluator.evaluatorVersion,
    evaluatorSourceSha256: evidence.evaluator.sourceSha256,
    evaluatorProtocolSha256: evidence.evaluator.protocolSha256,
    rawRowManifestSha256: evidence.rawResults.rowManifestSha256,
    rawResultsSha256: evidence.rawResults.rowResultsSha256,
    calibratorId: evidence.calibration.calibratorId,
    calibratorArtifactSha256: evidence.calibration.artifactSha256,
    signerKeyId: bundle.signature.keyId,
    signatureAlgorithm: bundle.signature.algorithm,
    signatureBase64Url: bundle.signature.signatureBase64Url,
    signedAt: bundle.signature.signedAt,
    evaluationCounts: evidence.counts,
    sliceMetrics: evidence.slices,
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

test("the v1 evidence schema is strict and accepts only a declared fixture baseline", () => {
  const value = fixtureBundle();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(value.evidence.eligibility, "fixture-regression");
});

test("aggregate-only or extensible evidence cannot satisfy the schema", () => {
  const aggregateOnly = fixtureBundle();
  delete aggregateOnly.evidence.rawResults;
  assert.equal(validate(aggregateOnly), false);

  const unknownField = fixtureBundle();
  unknownField.evidence.callerSuppliedPassed = true;
  assert.equal(validate(unknownField), false);
});

test("a release candidate requires a bound calibrator and approved external controls", () => {
  const value = fixtureBundle();
  value.evidence.eligibility = "release-candidate";
  assert.equal(validate(value), false);
});

test("ADR-0049 records the signed row-level evidence authority and fail-closed posture", () => {
  const adr = decisions.match(/## ADR-0049[\s\S]*?(?=\n---\n)/)?.[0] ?? "";
  assert.match(adr, /RFC 8785/);
  assert.match(adr, /Ed25519/);
  assert.match(adr, /row-level/i);
  assert.match(adr, /aggregate-only/i);
  assert.match(adr, /fixture/i);
  assert.match(adr, /no approved\s+calibrator|no release-eligible\s+(?:acoustic\s+)?evidence/i);
});

test("canonical verification protects the model-evidence contract", () => {
  const path = "tests/release/model-evidence.test.mjs";
  const invocations = verifySource
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes(path));
  assert.equal(invocations.length, 1, `${path} must run exactly once in canonical verification`);
});

test("RFC 8785 canonicalization pins ECMAScript numbers and UTF-16 property order", () => {
  assert.equal(
    canonicalizeRfc8785({
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0],
      z: true,
      a: false,
    }),
    '{"a":false,"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"z":true}',
  );
  assert.equal(
    canonicalizeRfc8785({
      "\u20ac": "Euro",
      "\r": "Carriage return",
      "\ufb33": "Hebrew",
      1: "One",
      "\ud83d\ude00": "Emoji",
      "\u0080": "Control",
      "\u00f6": "Latin",
    }),
    '{"\\r":"Carriage return","1":"One","\u0080":"Control","\u00f6":"Latin","\u20ac":"Euro","\ud83d\ude00":"Emoji","\ufb33":"Hebrew"}',
  );
  assert.throws(() => canonicalizeRfc8785("\ud800"), /lone surrogate/i);
  assert.throws(() => canonicalizeRfc8785(Number.NaN), /finite/i);
  assert.throws(() => canonicalizeRfc8785({ omitted: undefined }), /JSON value/i);
  assert.throws(() => canonicalizeRfc8785(Array(1)), /sparse|JSON array/i);
  assert.throws(
    () => canonicalizeRfc8785({ visible: true, [Symbol("hidden")]: false }),
    /symbol|JSON object/i,
  );
});

test("an ephemeral test-only Ed25519 signature verifies but never becomes release trust", () => {
  const { bundle, trustPolicy } = signedFixture();
  const verification = verifyModelEvidenceBundle(bundle, trustPolicy);
  assert.equal(verification.cryptographicallyValid, true);
  assert.equal(verification.evidenceId, bundle.evidence.evidenceId);
  assert.equal(verification.keyId, bundle.signature.keyId);
  assert.equal(verification.payloadSha256, bundle.signature.payloadSha256);
  assert.equal(verification.releaseTrusted, false);
  assert.equal(verification.trustClass, "test-only");
  assert.deepEqual(verification.evidence, bundle.evidence);
  assert.throws(
    () => verifyModelEvidenceBundle(bundle, trustPolicy, { requireReleaseTrust: true }),
    /test-only|release/i,
  );
});

test("the verifier fails closed on payload, hash, signature, schema, and key tampering", () => {
  const { bundle, trustPolicy } = signedFixture();

  const payloadTamper = structuredClone(bundle);
  payloadTamper.evidence.counts.rowCount += 1;
  assert.throws(() => verifyModelEvidenceBundle(payloadTamper, trustPolicy), /payload sha-256/i);

  const hashTamper = structuredClone(bundle);
  hashTamper.signature.payloadSha256 = `sha256:${"f".repeat(64)}`;
  assert.throws(() => verifyModelEvidenceBundle(hashTamper, trustPolicy), /payload sha-256/i);

  const signatureTamper = structuredClone(bundle);
  signatureTamper.signature.signatureBase64Url =
    `${signatureTamper.signature.signatureBase64Url[0] === "A" ? "B" : "A"}${signatureTamper.signature.signatureBase64Url.slice(1)}`;
  assert.throws(() => verifyModelEvidenceBundle(signatureTamper, trustPolicy), /signature/i);

  const schemaTamper = structuredClone(bundle);
  schemaTamper.evidence.callerSuppliedPassed = true;
  assert.throws(() => verifyModelEvidenceBundle(schemaTamper, trustPolicy), /schema/i);

  const keyTamper = structuredClone(bundle);
  keyTamper.signature.keyId = "unknown-key";
  assert.throws(() => verifyModelEvidenceBundle(keyTamper, trustPolicy), /not trusted/i);
});

test("operator trust policy is strict, unique, active, and Ed25519-public-only", () => {
  const { bundle, trustPolicy } = signedFixture();

  const duplicate = structuredClone(trustPolicy);
  duplicate.keys.push(structuredClone(duplicate.keys[0]));
  assert.throws(() => verifyModelEvidenceBundle(bundle, duplicate), /duplicate/i);

  const aliasedKey = structuredClone(trustPolicy);
  aliasedKey.keys.push({ ...structuredClone(aliasedKey.keys[0]), keyId: "second-key-id" });
  assert.throws(() => verifyModelEvidenceBundle(bundle, aliasedKey), /duplicate.*public key/i);

  const revoked = structuredClone(trustPolicy);
  revoked.keys[0].status = "revoked";
  assert.throws(() => verifyModelEvidenceBundle(bundle, revoked), /active/i);

  const privateMaterial = structuredClone(trustPolicy);
  privateMaterial.keys[0].publicKeyJwk.d = "private-material-is-forbidden";
  assert.throws(() => verifyModelEvidenceBundle(bundle, privateMaterial), /public|unknown/i);

  const malformed = structuredClone(trustPolicy);
  malformed.keys[0].publicKeyJwk.x = "not-an-ed25519-public-key";
  assert.throws(() => verifyModelEvidenceBundle(bundle, malformed), /Ed25519 public key/i);
});

test("the committed production policy starts empty and cannot verify a fixture", () => {
  const { bundle } = signedFixture();
  assert.deepEqual(productionTrustPolicy, {
    schemaVersion: "qrai-model-evaluation-trusted-signers/v1",
    policyId: "qrai-model-evaluation-production",
    keys: [],
  });
  assert.doesNotMatch(JSON.stringify(productionTrustPolicy), /privateKey|\"d\"\s*:/);
  assert.throws(() => verifyModelEvidenceBundle(bundle, productionTrustPolicy), /not trusted/i);
});

test("a release-class key cannot elevate fixture evidence", () => {
  const { bundle, trustPolicy } = signedFixture({ trustClass: "release" });
  const result = verifyModelEvidenceBundle(bundle, trustPolicy);
  assert.equal(result.trustClass, "release");
  assert.equal(result.releaseTrusted, false);
  assert.throws(
    () => verifyModelEvidenceBundle(bundle, trustPolicy, { requireReleaseTrust: true }),
    /eligibility|release-candidate/i,
  );
});

test("release trust cannot accept incomplete or contradictory evaluator/calibrator evidence", () => {
  const schemaFailures = [
    ["missing metric", (evidence) => evidence.uncertainty.intervals.pop()],
    [
      "duplicate metric",
      (evidence) => {
        evidence.uncertainty.intervals[7].metric = evidence.uncertainty.intervals[0].metric;
      },
    ],
  ];
  for (const [name, mutate] of schemaFailures) {
    const unsigned = releaseCandidateBundle();
    mutate(unsigned.evidence);
    const { bundle, trustPolicy } = signedFixture({ trustClass: "release", bundle: unsigned });
    assert.throws(
      () => verifyModelEvidenceBundle(bundle, trustPolicy, { requireReleaseTrust: true }),
      /schema/i,
      name,
    );
  }

  const gateFailures = [
    [
      "calibrator dataset authority mismatch",
      (evidence) => {
        evidence.calibration.fitDatasetManifestSha256 = `sha256:${"a".repeat(64)}`;
      },
    ],
    [
      "calibrator split authority mismatch",
      (evidence) => {
        evidence.calibration.fitSplitManifestSha256 = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "point estimate mismatch",
      (evidence) => {
        evidence.uncertainty.intervals[0].pointEstimate = 0.1;
      },
    ],
    [
      "inverted interval",
      (evidence) => {
        evidence.uncertainty.intervals[0].lower = 0.8;
        evidence.uncertainty.intervals[0].upper = 0.2;
      },
    ],
    [
      "impossible valid replicate count",
      (evidence) => {
        evidence.uncertainty.intervals[0].validReplicateCount = 10_001;
      },
    ],
  ];

  for (const [name, mutate] of gateFailures) {
    const unsigned = releaseCandidateBundle();
    mutate(unsigned.evidence);
    const { bundle, trustPolicy } = signedFixture({ trustClass: "release", bundle: unsigned });
    const verification = verifyModelEvidenceBundle(bundle, trustPolicy, { requireReleaseTrust: true });
    assert.equal(modelEvalPassesReleaseGate(evalRunFromBundle(bundle), verification), false, name);
  }
});

test("the release gate requires one verified, release-trusted, database-matching evidence payload", () => {
  const unsigned = releaseCandidateBundle();
  const { bundle, trustPolicy } = signedFixture({ trustClass: "release", bundle: unsigned });
  const verification = verifyModelEvidenceBundle(bundle, trustPolicy, { requireReleaseTrust: true });
  const run = evalRunFromBundle(bundle);
  assert.equal(modelEvalPassesReleaseGate(run, verification), true);

  const failures = [
    { name: "test trust", run, verification: { ...verification, trustClass: "test-only", releaseTrusted: false } },
    { name: "payload digest", run: { ...run, evidencePayloadSha256: digest }, verification },
    { name: "model artifact", run: { ...run, modelArtifactSha256: `sha256:${"f".repeat(64)}` }, verification },
    { name: "counts", run: { ...run, evaluationCounts: { ...run.evaluationCounts, rowCount: 41 } }, verification },
    { name: "slices", run: { ...run, sliceMetrics: run.sliceMetrics.slice(1) }, verification },
    { name: "calibrator", run: { ...run, calibratorId: "another-calibrator" }, verification },
    { name: "fixture eligibility", run: { ...run, evidenceEligibility: "fixture-regression" }, verification },
    { name: "legacy passed boolean", run: { ...run, evidencePayload: null }, verification },
  ];
  for (const failure of failures) {
    assert.equal(
      modelEvalPassesReleaseGate(failure.run, failure.verification),
      false,
      failure.name,
    );
  }
});

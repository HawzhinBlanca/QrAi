import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import {
  canonicalizeRfc8785,
  verifyModelEvidenceBundle,
} from "./model-evidence-verifier.mjs";

const fixture = JSON.parse(await readFile("services/ml-inference/fixtures/golden-evals.json", "utf8"));
const providedUrl = process.env.ML_INFERENCE_SMOKE_URL;
const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const artifactDir = join(artifactRoot, "ml");
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
const mlApiKey = process.env.ML_API_KEY ?? "smoke-ml-api-key";

await mkdir(artifactDir, { recursive: true });

const service = providedUrl ? null : await startMlService();
const baseUrl = providedUrl ?? service.baseUrl;

try {
  const health = await getJson("/health");
  assert(health.ok === true, "ML health did not report ok");
  assert(health.datasetVersion === fixture.datasetVersion, "ML health did not expose fixture datasetVersion");
  assert(
    fixture.cases.every((fixtureCase) => health.goldenCases.includes(fixtureCase.id)),
    "ML health did not expose all golden fixture cases",
  );

  const caseSummaries = [];
  for (const fixtureCase of fixture.cases) {
    const request = buildPredictionRequest(fixtureCase, {
      externalAsrRequested: true,
      consent: consent(true),
    });

    const alignment = await postJson("/v1/alignments:predict", request);
    assert(alignment.traceId === smokeTraceId, `${fixtureCase.id} alignment dropped smoke trace id`);
    assert(alignment.fixtureCaseId === fixtureCase.id, `${fixtureCase.id} alignment did not use golden fixture`);
    assert(
      alignment.alignments?.length === fixtureCase.alignment.words.length,
      `${fixtureCase.id} alignment response did not include fixture words`,
    );
    assert(
      alignment.alignments.every((item, index) => item.canonicalText === fixtureCase.alignment.words[index].canonicalText),
      `${fixtureCase.id} alignment words do not match fixture canonical text`,
    );
    assert(alignment.externalAsr.called === true, `${fixtureCase.id} external ASR stub was not called with valid consent`);
    assert(alignment.reviewStatus === "ai-suggested", `${fixtureCase.id} consented alignment should be AI suggested`);

    const tajweed = await postJson("/v1/tajweed-findings:predict", request);
    assert(tajweed.traceId === smokeTraceId, `${fixtureCase.id} tajweed dropped smoke trace id`);
    assert(tajweed.fixtureCaseId === fixtureCase.id, `${fixtureCase.id} tajweed did not use golden fixture`);
    assert(
      tajweed.annotations?.length === fixtureCase.tajweedFindings.length,
      `${fixtureCase.id} tajweed response did not include fixture instructional annotations`,
    );
    assert(
      tajweed.annotations.every((annotation) => annotation.sources?.length > 0),
      `${fixtureCase.id} tajweed instructional annotation was not source-backed`,
    );
    assert(
      tajweed.annotations.every((annotation) => annotation.auditEventId),
      `${fixtureCase.id} tajweed instructional annotation did not include audit id`,
    );
    assert(tajweed.findings?.length === 0, `${fixtureCase.id} exposed uncalibrated learner findings`);

    caseSummaries.push({
      id: fixtureCase.id,
      words: alignment.alignments.length,
      instructionalAnnotations: tajweed.annotations.length,
      learnerFindings: tajweed.findings.length,
      alignmentConfidence: alignment.confidence,
    });
  }

  const evaluation = await runDeclaredEvaluationSmoke();
  assert(evaluation.evidence.eligibility === "fixture-regression", "smoke evidence gained non-fixture eligibility");
  assert(evaluation.verification.cryptographicallyValid === true, "ephemeral fixture signature did not verify");
  assert(evaluation.verification.releaseTrusted === false, "ephemeral fixture signature gained release trust");

  const denied = await postJson("/v1/alignments:predict", buildPredictionRequest(fixture.cases[0], { externalAsrRequested: true }));
  assert(denied.traceId === smokeTraceId, "denied alignment dropped smoke trace id");
  assert(denied.externalAsr.called === false, "external ASR stub was called without consent");
  assert(denied.reviewStatus === "teacher-review-required", "non-consented local fallback should require teacher review");

  const allAudits = await getJson("/v1/audit-events?tenantId=tenant-smoke");
  const audit = allAudits.filter((event) => event.traceId === smokeTraceId);
  assert(audit.some((event) => event.action === "privacy.external-asr.called"), "missing external ASR call audit event");
  assert(audit.some((event) => event.action === "privacy.external-asr.denied"), "missing external ASR denial audit event");
  assert(
    audit.every((event) => event.traceId === smokeTraceId),
    `ML audit events did not retain smoke trace id: ${JSON.stringify(audit)}`,
  );

  const summary = {
    baseUrl,
    traceId: smokeTraceId,
    health,
    cases: caseSummaries,
    evaluation: {
      declaredFixture: true,
      evidenceId: evaluation.evidence.evidenceId,
      evidenceKind: evaluation.evidence.evidenceKind,
      eligibility: evaluation.evidence.eligibility,
      counts: evaluation.evidence.counts,
      cryptographicallyValid: evaluation.verification.cryptographicallyValid,
      releaseTrusted: evaluation.verification.releaseTrusted,
      trustClass: evaluation.verification.trustClass,
    },
    auditEventCount: audit.length,
  };

  await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(artifactDir, "evaluation-evidence.fixture.json"), JSON.stringify(evaluation.evidence, null, 2));
  await writeFile(join(artifactDir, "evaluation-bundle.fixture.json"), JSON.stringify(evaluation.bundle, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await service?.stop();
}

async function runDeclaredEvaluationSmoke() {
  const root = await mkdtemp(join(tmpdir(), "qrai-evaluation-smoke-"));
  const files = Object.fromEntries(
    [
      "request",
      "protocol",
      "registry",
      "modelArtifact",
      "implementation",
      "runtimeLock",
      "datasetManifest",
      "splitManifest",
      "rows",
      "output",
    ].map((name) => [name, join(root, name.endsWith("Artifact") ? `${name}.bin` : `${name}.json`)]),
  );

  const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
  const digestBytes = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const digestFile = async (path) => digestBytes(await readFile(path));

  try {
    await writeFile(files.modelArtifact, "declared-smoke-model-fixture");
    await writeFile(files.implementation, "declared-smoke-implementation-fixture");
    await writeFile(files.runtimeLock, "declared-smoke-runtime-lock-fixture");
    await writeJson(files.registry, { schemaVersion: "qrai-test-registry/v1" });

    const dataset = {
      schemaVersion: "qrai-evaluation-dataset/v1",
      datasetVersion: "declared-smoke-fixture-v1",
      evidenceClass: "declared-fixture",
      sealed: true,
      consentStatus: "test-only",
      licenseReviewStatus: "test-only",
    };
    const split = {
      schemaVersion: "qrai-evaluation-split/v1",
      heldOutReciterIds: ["fixture-reciter-1", "fixture-reciter-2"],
      calibrationReciterIds: [],
    };
    const protocol = {
      schemaVersion: "qrai-evaluation-protocol/v1",
      protocolVersion: "declared-smoke-protocol-v1",
      approvalStatus: "test-only",
      operatingThreshold: 0.5,
      calibrationBins: 2,
      bootstrap: { confidenceLevel: 0.95, replicateCount: 50, seed: 7 },
      requiredSlices: [
        {
          sliceId: "fixture-slice",
          dimensions: {
            languageBackground: "test-only",
            ageBand: "test-only",
            deviceClass: "test-only",
            noiseCondition: "test-only",
          },
        },
      ],
    };
    const rows = [
      { rowId: "row-1", reciterId: "fixture-reciter-1", splitId: "held-out", label: 1, score: 0.9, sliceIds: ["fixture-slice"], sourceBacked: true, ratings: [1, 1] },
      { rowId: "row-2", reciterId: "fixture-reciter-1", splitId: "held-out", label: 0, score: 0.8, sliceIds: ["fixture-slice"], sourceBacked: true, ratings: [0, 0] },
      { rowId: "row-3", reciterId: "fixture-reciter-2", splitId: "held-out", label: 1, score: 0.7, sliceIds: ["fixture-slice"], sourceBacked: true, ratings: [1, 1] },
      { rowId: "row-4", reciterId: "fixture-reciter-2", splitId: "held-out", label: 0, score: 0.1, sliceIds: ["fixture-slice"], sourceBacked: true, ratings: [0, 0] },
    ];
    await writeJson(files.datasetManifest, dataset);
    await writeJson(files.splitManifest, split);
    await writeJson(files.protocol, protocol);
    await writeJson(files.rows, rows);

    await writeJson(files.request, {
      schemaVersion: "qrai-evaluation-request/v1",
      evaluationTask: "acoustic-tajweed",
      eligibility: "fixture-regression",
      generatedAt: "2026-08-07T00:00:00Z",
      candidate: {
        candidateId: "declared-smoke-candidate",
        modelVersion: "declared-smoke-model-v1",
        modelArtifactSha256: await digestFile(files.modelArtifact),
        implementationSha256: await digestFile(files.implementation),
        runtimeLockSha256: await digestFile(files.runtimeLock),
        imageDigest: digestBytes("declared-smoke-image-fixture"),
        registrySha256: await digestFile(files.registry),
        executionStatus: "test-only",
        licenseReviewStatus: "test-only",
      },
      dataset: {
        datasetVersion: dataset.datasetVersion,
        evidenceClass: dataset.evidenceClass,
        manifestSha256: await digestFile(files.datasetManifest),
        splitManifestSha256: await digestFile(files.splitManifest),
        splitId: "held-out",
        sealed: true,
        reciterDisjoint: true,
        consentStatus: "test-only",
        licenseReviewStatus: "test-only",
      },
      protocol: {
        protocolVersion: protocol.protocolVersion,
        protocolSha256: await digestFile(files.protocol),
      },
      rawResults: { rowResultsSha256: await digestFile(files.rows) },
      calibration: null,
      approvals: [],
    });

    await runProcess("python3", [
      "services/asr-inference/evaluate_candidate.py",
      "--request", files.request,
      "--protocol", files.protocol,
      "--registry", files.registry,
      "--model-artifact", files.modelArtifact,
      "--implementation", files.implementation,
      "--runtime-lock", files.runtimeLock,
      "--dataset-manifest", files.datasetManifest,
      "--split-manifest", files.splitManifest,
      "--rows", files.rows,
      "--output", files.output,
    ]);
    const evidence = JSON.parse(await readFile(files.output, "utf8"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from(canonicalizeRfc8785(evidence), "utf8");
    const keyId = "ephemeral-smoke-test-key";
    const bundle = {
      schemaVersion: "qrai-model-evaluation-bundle/v1",
      canonicalization: "RFC8785",
      evidence,
      signature: {
        schemaVersion: "qrai-model-evaluation-signature/v1",
        algorithm: "Ed25519",
        keyId,
        payloadSha256: digestBytes(payload),
        signatureBase64Url: sign(null, payload, privateKey).toString("base64url"),
        signedAt: "2026-08-07T00:00:00Z",
      },
    };
    const trustPolicy = {
      schemaVersion: "qrai-model-evaluation-trusted-signers/v1",
      policyId: "ephemeral-smoke-test-policy",
      keys: [
        {
          keyId,
          algorithm: "Ed25519",
          trustClass: "test-only",
          status: "active",
          publicKeyJwk: publicKey.export({ format: "jwk" }),
        },
      ],
    };
    const verification = verifyModelEvidenceBundle(bundle, trustPolicy);
    return { bundle, evidence, verification };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function buildPredictionRequest(fixtureCase, overrides = {}) {
  return {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    sessionId: `session-smoke-${Date.now()}`,
    quranRef: fixtureCase.quranRef,
    sourceChecksum: fixtureCase.sourceChecksum,
    evidenceIds: fixtureCase.evidenceIds,
    sampleRate: 16000,
    language: "ckb",
    externalAsrRequested: false,
    consent: consent(false),
    ...overrides,
  };
}

function consent(isAllowed) {
  return {
    audioRetention: "discard",
    anonymizedLearning: true,
    externalAsrProcessing: isAllowed,
    guardianApproved: isAllowed,
    consentVersion: "smoke-v1",
  };
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "x-ml-api-key": mlApiKey },
  });
  return readResponse(response, path);
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": mlApiKey },
    body: JSON.stringify(body),
  });
  return readResponse(response, path);
}

async function readResponse(response, path) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${text}`);
  }
  return body;
}

async function startMlService() {
  const port = await getFreePort();
  const logPath = join(artifactDir, "service.log");
  const child = spawn(process.execPath, ["services/ml-inference/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(port),
      ML_EXTERNAL_ASR_TENANTS: "tenant-smoke",
      // This smoke asserts deterministic golden-fixture behavior, so run ml in fixture
      // mode (it defaults OFF so learners get real computed alignment).
      ML_USE_GOLDEN_FIXTURES: "1",
      // Required alongside it since P3.2. Fixture mode reports recitations nobody performed, and its
      // tajweed findings persist as though they were real; the service refuses to start without this
      // acknowledgement so the choice cannot be made absent-mindedly. A smoke run is exactly the
      // place it IS intended.
      ML_ACKNOWLEDGE_FIXTURE_OUTPUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  return {
    baseUrl,
    async stop() {
      child.kill("SIGTERM");
      await writeFile(logPath, logs.join(""));
    },
  };
}

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ML service did not become healthy: ${lastError?.message ?? "timeout"}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

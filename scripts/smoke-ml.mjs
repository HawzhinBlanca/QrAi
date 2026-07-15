import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

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
      tajweed.findings?.length === fixtureCase.tajweedFindings.length,
      `${fixtureCase.id} tajweed response did not include fixture findings`,
    );
    assert(
      tajweed.findings.every((finding) => finding.sources?.length > 0),
      `${fixtureCase.id} tajweed finding was not source-backed`,
    );
    assert(
      tajweed.findings.every((finding) => finding.auditEventId),
      `${fixtureCase.id} tajweed finding did not include audit id`,
    );

    caseSummaries.push({
      id: fixtureCase.id,
      words: alignment.alignments.length,
      findings: tajweed.findings.length,
      confidence: {
        alignment: alignment.confidence,
        tajweed: tajweed.confidence,
      },
    });
  }

  const evalRun = await postJson("/v1/eval-runs", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    modelVersion: fixture.modelVersion,
    datasetVersion: fixture.datasetVersion,
  });
  assert(evalRun.passed === true, "eval run did not pass threshold gate");
  assert(evalRun.wordAlignmentF1 === fixture.metrics.wordAlignmentF1, "eval run did not load fixture alignment metric");
  assert(evalRun.tajweedF1 === fixture.metrics.tajweedF1, "eval run did not load fixture tajweed metric");
  assert(evalRun.unsourcedLearnerOutputs === 0, "eval run allows unsourced learner outputs");
  // Source-integrity is recomputed live by the service from the committed golden findings; assert the
  // endpoint's count matches an INDEPENDENT recompute over the same cases (no static, drift-prone field).
  const expectedSourceBacked = fixture.cases
    .flatMap((c) => c.tajweedFindings ?? [])
    .filter((f) => Array.isArray(f.sources) && f.sources.length > 0).length;
  assert(
    evalRun.sourceBackedFindings === expectedSourceBacked,
    "eval run did not recompute the source-backed finding count",
  );

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
    evalRun,
    auditEventCount: audit.length,
  };

  await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(artifactDir, "eval-run.json"), JSON.stringify(evalRun, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await service?.stop();
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const providedUrl = process.env.ML_INFERENCE_SMOKE_URL;
const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const artifactDir = join(artifactRoot, "privacy");
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
const retainedLearnerId = `learner-retained-${randomUUID()}`;
const retainedChunkId = `chunk-retained-${randomUUID()}`;

await mkdir(artifactDir, { recursive: true });

const service = providedUrl ? null : await startMlService();
const baseUrl = providedUrl ?? service.baseUrl;

try {
  const denied = await postJson("/v1/alignments:predict", predictionRequest({
    externalAsrRequested: true,
    consent: consent(false),
  }));
  assert(denied.traceId === smokeTraceId, "revoked consent prediction dropped smoke trace id");
  assert(denied.externalAsr.called === false, "revoked consent still allowed external ASR");
  assert(denied.reviewStatus === "teacher-review-required", "revoked consent did not force teacher review fallback");

  const childDenied = await postJson("/v1/alignments:predict", predictionRequest({
    profileKind: "child",
    externalAsrRequested: true,
    consent: {
      ...consent(true),
      guardianApproved: false,
    },
  }));
  assert(childDenied.traceId === smokeTraceId, "child denied prediction dropped smoke trace id");
  assert(childDenied.externalAsr.called === false, "child profile allowed external ASR without guardian consent");

  const allowed = await postJson("/v1/alignments:predict", predictionRequest({
    profileKind: "child",
    externalAsrRequested: true,
    consent: consent(true),
  }));
  assert(allowed.traceId === smokeTraceId, "allowed prediction dropped smoke trace id");
  assert(allowed.externalAsr.called === true, "guardian-approved consent did not allow external ASR");

  const exported = await postJson("/v1/privacy/export", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    learnerId: "learner-smoke",
  });
  assert(exported.traceId === smokeTraceId, "privacy export dropped smoke trace id");
  assert(exported.audioObjectKeys.length === 0, "discard-mode smoke should not persist audio object keys");
  assert(exported.metadataObjectKeys.length === 0, "discard-mode smoke should not persist audio metadata keys");
  assert(exported.externalAsrCalls.length === 1, "privacy export did not include opted-in external ASR audit");
  assert(exported.deniedExternalAsr.length >= 2, "privacy export did not include denial audits");
  assert(
    exported.auditEvents.every((event) => event.traceId === smokeTraceId),
    `privacy export audit events did not retain smoke trace id: ${JSON.stringify(exported.auditEvents)}`,
  );

  const deletion = await postJson("/v1/privacy/delete", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    learnerId: "learner-smoke",
  });
  assert(deletion.traceId === smokeTraceId, "privacy delete dropped smoke trace id");
  assert(deletion.status === "completed", "privacy delete job did not complete");
  assert(deletion.deletedAudioObjectKeys.length === 0, "privacy delete reported unexpected audio keys");
  assert(deletion.deletedMetadataObjectKeys.length === 0, "privacy delete reported unexpected metadata keys");
  assert(deletion.tombstonedDerivedRecords === true, "privacy delete did not tombstone derived records");

  const traversalStore = await postRaw("/v1/audio-chunks", {
    tenantId: "tenant-smoke",
    learnerId: "../learner-path-escape",
    sessionId: `session-traversal-${randomUUID()}`,
    chunkId: "chunk-traversal",
    sampleRate: 16000,
    startMs: 0,
    endMs: 640,
    audioBase64: Buffer.from("path-traversal-smoke").toString("base64"),
    traceId: smokeTraceId,
  });
  assert(
    traversalStore.response.status === 400,
    `path traversal learner id should be rejected with 400, got ${traversalStore.response.status}: ${JSON.stringify(traversalStore.body)}`,
  );

  const retainedAudio = await postJson("/v1/audio-chunks", {
    tenantId: "tenant-smoke",
    learnerId: retainedLearnerId,
    sessionId: `session-retained-${randomUUID()}`,
    chunkId: retainedChunkId,
    sampleRate: 16000,
    startMs: 0,
    endMs: 640,
    audioBase64: Buffer.from("retained-audio-smoke").toString("base64"),
    traceId: smokeTraceId,
  });
  assert(retainedAudio.stored === true, "retained audio chunk was not stored");
  assert(
    retainedAudio.objectKey === `tenant-smoke/${retainedLearnerId}/${retainedChunkId}.bin`,
    `retained audio object key was unexpected: ${JSON.stringify(retainedAudio)}`,
  );

  const retainedExport = await postJson("/v1/privacy/export", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    learnerId: retainedLearnerId,
  });
  assert(retainedExport.audioObjectKeys.length === 1, "retained audio export did not include the audio object");
  assert(
    retainedExport.metadataObjectKeys.length === 1,
    `retained audio export did not include metadata sidecar: ${JSON.stringify(retainedExport)}`,
  );

  const retainedDeletion = await postJson("/v1/privacy/delete", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    learnerId: retainedLearnerId,
  });
  assert(retainedDeletion.status === "completed", "retained audio delete job did not complete");
  assert(retainedDeletion.deletedAudioObjectKeys.length === 1, "retained audio delete did not remove audio object");
  assert(
    retainedDeletion.deletedMetadataObjectKeys.length === 1,
    `retained audio delete did not remove metadata sidecar: ${JSON.stringify(retainedDeletion)}`,
  );

  const retainedAfterDelete = await postJson("/v1/privacy/export", {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    learnerId: retainedLearnerId,
  });
  assert(retainedAfterDelete.audioObjectKeys.length === 0, "retained audio object remained after delete");
  assert(retainedAfterDelete.metadataObjectKeys.length === 0, "retained metadata sidecar remained after delete");

  const summary = {
    traceId: smokeTraceId,
    denied: denied.externalAsr,
    childDenied: childDenied.externalAsr,
    allowed: allowed.externalAsr,
    export: {
      audioObjectKeys: exported.audioObjectKeys.length,
      metadataObjectKeys: exported.metadataObjectKeys.length,
      externalAsrCalls: exported.externalAsrCalls.length,
      deniedExternalAsr: exported.deniedExternalAsr.length,
      auditEvents: exported.auditEvents.length,
    },
    deletion,
    traversalRejectedStatus: traversalStore.response.status,
    retainedAudio: {
      objectKey: retainedAudio.objectKey,
      exportAudioObjectKeys: retainedExport.audioObjectKeys.length,
      exportMetadataObjectKeys: retainedExport.metadataObjectKeys.length,
      deletedAudioObjectKeys: retainedDeletion.deletedAudioObjectKeys.length,
      deletedMetadataObjectKeys: retainedDeletion.deletedMetadataObjectKeys.length,
      postDeleteAudioObjectKeys: retainedAfterDelete.audioObjectKeys.length,
      postDeleteMetadataObjectKeys: retainedAfterDelete.metadataObjectKeys.length,
    },
  };

  await writeFile(join(artifactDir, "privacy-report.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await service?.stop();
}

function predictionRequest(overrides = {}) {
  return {
    tenantId: "tenant-smoke",
    traceId: smokeTraceId,
    sessionId: `session-privacy-${Date.now()}`,
    quranRef: {
      surahNumber: 1,
      ayahStart: 1,
      ayahEnd: 7,
      display: "Al-Fatihah 1:1-7",
    },
    sourceChecksum: "fnv1a32:privacy-smoke",
    evidenceIds: ["evidence-privacy-smoke"],
    sampleRate: 16000,
    language: "ckb",
    externalAsrRequested: true,
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
    consentVersion: "privacy-smoke-v1",
  };
}

async function postJson(path, body) {
  const { response, body: payload, text } = await postRaw(path, body);
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${text}`);
  }
  return payload;
}

async function postRaw(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, body: payload, text };
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
      AUDIO_STORAGE_DIR: join(artifactDir, "audio-storage"),
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
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // service is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("ML service did not become healthy");
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

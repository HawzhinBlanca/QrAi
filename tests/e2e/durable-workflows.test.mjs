import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { createApplication } from "../../server/src/app.mjs";
import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";
import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import {
  createTestDatabase,
  migrationTestAdminUrl,
} from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const TENANT = "hikmah-pilot-erbil";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function appConnectionString(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

function attribution(component, implementationId, digest, basis) {
  return {
    analysisBasis: basis,
    artifactDigest: digest,
    calibratorId: null,
    component,
    datasetVersion: `declared-${component}-dataset`,
    implementationId,
    status: "active",
  };
}

function createInferenceMock(modelBySession) {
  const calls = [];
  const record = async (path, body, deadline) => {
    deadline?.throwIfExpired();
    calls.push({ path, body });
    await sleep(60);
    deadline?.throwIfExpired();
  };
  const inference = createInferenceRuntime({
    async transcribeSession(body, deadline) {
      await record("/v1/session-transcript", body, deadline);
      const asr = attribution("asr", "declared-asr-fixture", DIGEST_A, "acoustic");
      return {
        chunkCount: 1,
        missingChunkIds: [],
        modelAttribution: { components: [asr], primaryComponent: "asr", schemaVersion: 1 },
        modelVersion: "declared-asr-fixture",
        reason: "consent-granted",
        recognizedTokens: [
          { confidence: 0.93, endMs: 500, startMs: 0, text: "declared-fixture" },
        ],
        transcriptSource: "server-derived",
        transcribed: true,
      };
    },
    async predictAlignment(body, deadline) {
      await record("/v1/alignments:predict", body, deadline);
      const model = modelBySession.get(body.sessionId);
      const asr = attribution("asr", "declared-asr-fixture", DIGEST_A, "acoustic");
      const aligner = attribution("quran-aligner", model, DIGEST_B, "quran-constrained");
      return {
        alignments: [
          {
            confidence: 0.91,
            endMs: 500,
            heardText: "declared-fixture",
            startMs: 0,
            status: "matched",
            wordId: "1:1:1",
          },
        ],
        datasetVersion: "declared-quran-aligner-dataset",
        evidenceId: "declared-durable-workflow-evidence",
        finalizable: true,
        latencyMs: 9,
        modelAttribution: {
          components: [asr, aligner],
          primaryComponent: "quran-aligner",
          schemaVersion: 1,
        },
        modelVersion: model,
        nonFinalizedReason: null,
        sessionId: body.sessionId,
      };
    },
    async predictTajweed(body, deadline) {
      await record("/v1/tajweed-findings:predict", body, deadline);
      return { annotations: [], findings: [], sessionId: body.sessionId };
    },
  });
  return { calls, inference };
}

function identity(userId, role = "learner") {
  return {
    "content-type": "application/json",
    "x-tenant-id": TENANT,
    "x-user-id": userId,
    "x-user-role": role,
  };
}

async function post(app, url, userId, body = {}, role = "learner") {
  const response = await app.inject({
    method: "POST",
    url,
    headers: identity(userId, role),
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

test("durable domain workflows deduplicate effects and recover the privacy deletion window", async (t) => {
  const database = await createTestDatabase(t, "durable_workflows");
  if (!database) return;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "durable-workflow-test-password";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });
  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const connectionString = appConnectionString(database.connectionString, roleName, password);
  const db = createDb(connectionString);
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const [learner] = (await admin.query(
    "select id from users where tenant_id = $1 and role = 'learner' order by id limit 1",
    [TENANT],
  )).rows;
  const [operator] = (await admin.query(
    "select id from users where tenant_id = $1 and role in ('admin', 'ops') order by id limit 1",
    [TENANT],
  )).rows;
  assert.ok(learner);
  assert.ok(operator);

  const storageRoot = mkdtempSync(join(tmpdir(), "qrai-durable-workflows-"));
  const objectStore = createFilesystemAudioObjectStore({ rootDir: storageRoot });
  const modelBySession = new Map();
  const ml = createInferenceMock(modelBySession);
  const app = createApplication({
    databaseUrl: connectionString,
    allowHeaderAuth: true,
    enforceRestrictedDbRole: true,
    rateLimitEnabled: false,
    mlApiKey: "declared-durable-workflow-key",
    audioObjectStore: objectStore,
    upstreamTimeoutMs: 1_000,
    logger: false,
  });
  await app.ready();

  async function createSession(userId, suffix) {
    const response = await post(app, "/v1/recitation-sessions", userId, {
      consent: {
        anonymizedLearning: false,
        audioRetention: "teacher-review",
        consentVersion: "declared-durable-workflow-v1",
        externalAsrProcessing: true,
        guardianApproved: true,
      },
      language: "ckb",
      learnerId: userId,
      mode: "guided-recite",
      practicePlanId: "declared-durable-workflow",
      quranRef: { ayahEnd: 1, ayahStart: 1, display: "Al-Fatihah 1:1", surahNumber: 1 },
      sourceChecksum: `declared:${suffix}`,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    modelBySession.set(response.body.id, response.body.modelVersion);
    return response.body.id;
  }

  const workerHandlers = createWorkflowHandlers({
    db,
    inference: ml.inference,
    audioObjectStore: objectStore,
    upstreamTimeoutMs: 1_000,
  });
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db }),
    handlers: workerHandlers,
    workerId: "deduplication-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_000,
    retryBaseMs: 1,
    retryMaxMs: 10,
  });
  let workerRunning = true;
  const workerLoop = (async () => {
    while (workerRunning) {
      const ownedSessions = [...modelBySession.keys()];
      if (ownedSessions.length === 0) {
        await sleep(5);
        continue;
      }
      const jobId = await db.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind IN ('session.finalize', 'session.evaluate')
            AND subject_id = ANY(${ownedSessions})
            AND status IN ('queued', 'retry')
            AND available_at <= now()
          ORDER BY priority DESC, created_at, id
          LIMIT 1`;
        return row?.id ?? null;
      });
      if (jobId === null) await sleep(5);
      else await workerRuntime.runOne(TENANT, { jobId });
    }
  })();

  try {
  try {
  await t.test("concurrent finalization and evaluation share one lease and one result", async () => {
    const sessionId = await createSession(learner.id, randomUUID());
    ml.calls.length = 0;
    const [first, duplicate] = await Promise.all([
      post(app, `/v1/recitation-sessions/${sessionId}/finalize`, learner.id),
      post(app, `/v1/recitation-sessions/${sessionId}/finalize`, learner.id),
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(duplicate.body, first.body);
    assert.equal(ml.calls.filter(({ path }) => path === "/v1/session-transcript").length, 1);
    assert.equal(ml.calls.filter(({ path }) => path === "/v1/alignments:predict").length, 1);

    const finalization = await admin.query(
      `select status, count(*)::int as count from background_jobs
       where tenant_id = $1 and kind = 'session.finalize' and subject_id = $2 group by status`,
      [TENANT, sessionId],
    );
    assert.deepEqual(finalization.rows, [{ status: "completed", count: 1 }]);
    const effects = await admin.query(
      "select count(*)::int as count from alignment_runs where tenant_id = $1 and session_id = $2",
      [TENANT, sessionId],
    );
    assert.equal(effects.rows[0].count, 1);

    ml.calls.length = 0;
    const evaluateBody = {
      sessionId,
      quranRef: { ayahEnd: 1, ayahStart: 1, display: "forged", surahNumber: 114 },
    };
    const [evaluated, evaluatedDuplicate] = await Promise.all([
      post(app, "/v1/ml/tajweed-findings:predict", learner.id, evaluateBody),
      post(app, "/v1/ml/tajweed-findings:predict", learner.id, evaluateBody),
    ]);
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.deepEqual(evaluatedDuplicate.body, evaluated.body);
    assert.equal(ml.calls.filter(({ path }) => path === "/v1/tajweed-findings:predict").length, 1);
    const evaluations = await admin.query(
      `select status, count(*)::int as count from background_jobs
       where tenant_id = $1 and kind = 'session.evaluate' and subject_id = $2 group by status`,
      [TENANT, sessionId],
    );
    assert.deepEqual(evaluations.rows, [{ status: "completed", count: 1 }]);
  });
  } finally {
    workerRunning = false;
    await workerLoop;
  }

  await t.test("retry after deletion-before-commit uses the durable manifest and cascades once", async () => {
    const sessionId = await createSession(learner.id, randomUUID());
    const stored = await objectStore.put({
      tenantId: TENANT,
      learnerId: learner.id,
      sessionId,
      chunkId: `chunk-${randomUUID()}`,
      startMs: 0,
      endMs: 100,
      sampleRate: 16_000,
      audioRetention: "teacher-review",
      audioBytes: Buffer.alloc(3_200, 7),
    });
    const store = createJobStore({ db });
    const queued = await store.enqueue({
      tenantId: TENANT,
      kind: "privacy.delete",
      subjectId: learner.id,
      actorId: operator.id,
      idempotencyKey: `privacy-crash:${randomUUID()}`,
      payload: {
        learnerId: learner.id,
        inputVersion: "declared-crash-window",
        includedRecords: [sessionId, `audio_object:${stored.objectKey}`],
        audioObjectKeys: [stored.objectKey],
        traceId: null,
      },
      maxAttempts: 3,
    });
    const handlers = createWorkflowHandlers({
      db,
      inference: ml.inference,
      audioObjectStore: objectStore,
      upstreamTimeoutMs: 1_000,
    });
    let injectCrash = true;
    const crashStore = {
      ...store,
      async complete(input) {
        if (injectCrash) {
          injectCrash = false;
          throw Object.assign(new Error("declared crash before fenced commit"), {
            jobErrorCode: "declared_process_crash",
          });
        }
        return store.complete(input);
      },
    };
    const firstRuntime = createJobRuntime({
      store: crashStore,
      handlers,
      workerId: "worker-before-crash",
      leaseMs: 500,
      operationTimeoutMs: 250,
      retryBaseMs: 1,
      retryMaxMs: 10,
    });
    const first = await firstRuntime.runOne(TENANT, { jobId: queued.id });
    assert.equal(first.outcome, "retry");
    assert.deepEqual(
      await objectStore.listLearner({ tenantId: TENANT, learnerId: learner.id }),
      [],
      "the declared crash must occur after object deletion",
    );
    assert.equal(
      (await admin.query("select count(*)::int as count from recitation_sessions where id = $1", [sessionId])).rows[0].count,
      1,
      "the database effect must not partially commit",
    );
    assert.equal(
      (await admin.query("select count(*)::int as count from privacy_jobs where learner_id = $1", [learner.id])).rows[0].count,
      0,
    );

    await sleep(15);
    const recoveryRuntime = createJobRuntime({
      store,
      handlers,
      workerId: "worker-after-crash",
      leaseMs: 500,
      operationTimeoutMs: 250,
      retryBaseMs: 1,
      retryMaxMs: 10,
    });
    const recovered = await recoveryRuntime.runOne(TENANT, { jobId: queued.id });
    assert.equal(recovered.outcome, "completed");
    const response = JSON.parse(recovered.job.result.responseJson);
    assert.deepEqual(response.audioObjectKeysDeleted, [stored.objectKey]);
    assert.ok(response.deletedRecords.includes(`audio_object:${stored.objectKey}`));
    assert.equal(
      (await admin.query("select count(*)::int as count from recitation_sessions where id = $1", [sessionId])).rows[0].count,
      0,
    );
    assert.equal(
      (await admin.query("select count(*)::int as count from privacy_jobs where learner_id = $1", [learner.id])).rows[0].count,
      1,
    );
    assert.equal(recovered.job.attemptCount, 2);
  });
  } finally {
    await app.close();
    await db.end();
    await admin.end();
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

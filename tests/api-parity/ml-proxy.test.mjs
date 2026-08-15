import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";

import {
  DATABASE_URL,
  DECLARED_TEST_ACOUSTIC_EVIDENCE,
  TENANT,
  insertDeclaredTestAcousticFinding,
  purgeSessionsByChecksum,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  uniqueSuffix,
} from "./lib/harness.mjs";

// Run-scoped session checksums, so the teardown at the end of this file deletes exactly this run's
// rows and nothing else. These suites created sessions and never removed them: measured, the shared
// staging database had accumulated 64,869 recitation sessions across ~8 fixed checksums, growing by
// thousands a day. Leaked rows already broke a review-parity assertion and a Rust integration test
// once in this program (`seedQueued`), and an unbounded corpus is what makes ORDER BY without a
// unique tiebreaker, row-count deltas, and other suites' bulk teardown intermittently fail.
// Per-run rather than a shared literal: two agents run this gate against the same Postgres.
const RUN_CK_PRIVACY = `fnv1a32:privacy-scope-${uniqueSuffix()}`;
const RUN_CK_CONSENT_TEST = `fnv1a32:consent-test-${uniqueSuffix()}`;

import {
  createFilesystemAudioObjectStore,
  deriveAudioObjectKey,
} from "../../server/src/storage/audio-object-store.mjs";

/**
 * PAR3 — config group: ML_INFERENCE_URL pointed at a mock upstream.
 * specs/api-parity-suite/plan.md §4
 *
 * The mock starts BEFORE the server, because AppState resolves ML_INFERENCE_URL once at startup
 * (lib.rs:78). One mock serves every path for the group; behaviour is per-path rather than
 * per-test, since a single server instance is shared.
 */

const ERASED_KEYS = {
  deletedAudioObjectKeys: ["hikmah-pilot-erbil/learner/chunk-1.bin"],
  deletedMetadataObjectKeys: ["hikmah-pilot-erbil/learner/chunk-1.meta.json"],
};

const declaredPredictionProvenance = () => ({
  modelVersion: DECLARED_TEST_ACOUSTIC_EVIDENCE.modelVersion,
  modelArtifactSha256: DECLARED_TEST_ACOUSTIC_EVIDENCE.modelArtifactSha256,
  acousticDatasetVersion: DECLARED_TEST_ACOUSTIC_EVIDENCE.datasetVersion,
  acousticDatasetManifestSha256: DECLARED_TEST_ACOUSTIC_EVIDENCE.datasetManifestSha256,
  calibratorId: DECLARED_TEST_ACOUSTIC_EVIDENCE.calibratorId,
  calibratorArtifactSha256: DECLARED_TEST_ACOUSTIC_EVIDENCE.calibratorArtifactSha256,
  evaluationEvidenceId: DECLARED_TEST_ACOUSTIC_EVIDENCE.evidenceId,
  evaluationEvidenceSha256: DECLARED_TEST_ACOUSTIC_EVIDENCE.evidenceSha256,
});

function respondMl({ path, body }) {
  if (path === "/v1/privacy/delete") return { status: 200, body: ERASED_KEYS };
  if (path === "/v1/tajweed-findings:predict") {
    return {
      status: 200,
      body: {
        ...body,
        modelVersion: DECLARED_TEST_ACOUSTIC_EVIDENCE.modelVersion,
        annotations: [],
        findings: [
          {
            ...declaredPredictionProvenance(),
            wordId: "1:1:1",
            rule: "ghunnah",
            analysisBasis: "acoustic",
            severity: "practice",
            confidence: 0.9,
            explanation: "Apply ghunnah on the noon sakina.",
            sources: [{ id: "s1", title: "Board", citation: "policy" }],
            reviewStatus: "ai-suggested",
          },
          {
            ...declaredPredictionProvenance(),
            wordId: "1:1:2",
            rule: "madd-tabii",
            analysisBasis: "acoustic",
            severity: "practice",
            confidence: 0.9,
            explanation: "Hold the natural madd for two counts.",
            sources: [{ id: "s2", title: "Board", citation: "policy" }],
            reviewStatus: "ai-suggested",
          },
        ],
      },
    };
  }
  return {
    status: 200,
    body: {
      ...body,
      modelVersion: "declared-quran-aligner-fixture",
      modelAttribution: {
        schemaVersion: 1,
        primaryComponent: "quran-aligner",
        components: [
          {
            component: "quran-aligner",
            status: "active",
            implementationId: "declared-quran-aligner-fixture",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            datasetVersion: "declared-fixture",
            analysisBasis: "quran-constrained",
            calibratorId: null,
          },
        ],
      },
    },
  };
}

let api;
let mock;
let audioStorageDir;
let audioObjectStore;
let workerDb;
let workerLoop;
let workerRunning = false;
const ownedJobSubjects = new Set();

before(async () => {
  audioStorageDir = mkdtempSync(join(tmpdir(), "qrai-ml-proxy-storage-"));
  audioObjectStore = createFilesystemAudioObjectStore({ rootDir: audioStorageDir });
  mock = await startMockUpstream(respondMl);
  const inference = createInferenceRuntime({
    async predictAlignment(body) {
      return respondMl({ path: "/v1/alignments:predict", body }).body;
    },
    async predictTajweed(body) {
      return respondMl({ path: "/v1/tajweed-findings:predict", body }).body;
    },
    async transcribeSession() {
      return { reason: "no-finalization-in-this-suite", transcribed: false };
    },
  });
  workerDb = createDb(DATABASE_URL);
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      audioObjectStore,
      mlInferenceUrl: mock.url,
      mlApiKey: "smoke-ml-api-key",
      upstreamTimeoutMs: 1_000,
    }),
    workerId: "ml-proxy-parity-worker",
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  workerRunning = true;
  workerLoop = (async () => {
    while (workerRunning) {
      const subjects = [...ownedJobSubjects];
      if (subjects.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const jobId = await workerDb.withTenant(TENANT, async (tx) => {
        const [row] = await tx`
          SELECT id
          FROM background_jobs
          WHERE tenant_id = ${TENANT}
            AND kind IN ('privacy.export', 'privacy.delete', 'session.evaluate')
            AND subject_id = ANY(${subjects})
            AND status IN ('queued', 'retry')
            AND available_at <= now()
          ORDER BY priority DESC, created_at, id
          LIMIT 1`;
        return row?.id ?? null;
      });
      if (jobId === null) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await workerRuntime.runOne(TENANT, { jobId });
      }
    }
  })();
  api = await startApi({
    env: { ML_INFERENCE_URL: mock.url, AUDIO_STORAGE_DIR: audioStorageDir },
  });
});

after(async () => {
  let workerFailure = null;
  workerRunning = false;
  try {
    await workerLoop;
  } catch (error) {
    workerFailure = error;
  }
  await workerDb?.end();
  await api?.stop();
  await mock?.stop();
  if (audioStorageDir) rmSync(audioStorageDir, { recursive: true, force: true });
  if (workerFailure) throw workerFailure;
});

const seedLearners = async (...ids) => {
  for (const id of ids) {
    await queryJson(
      `INSERT INTO users (id, tenant_id, display_name, role, language)
       VALUES ($1, $2, 'Parity Privacy', 'learner', 'ckb')`,
      [id, TENANT],
    );
    ownedJobSubjects.add(id);
  }
};

const createSession = async (learnerId) => {
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "admin",
    body: {
      learnerId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: RUN_CK_PRIVACY,
      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "discard",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(created.status, 200, `session setup failed: ${JSON.stringify(created.body)}`);
  ownedJobSubjects.add(created.body.id);
  return created.body.id;
};

/** integration.rs:1795 — seed_reviewed_finding. */
const seedReviewedFinding = async (sessionId, label) => {
  const s = uniqueSuffix();
  const ids = {
    alignment: `wa-parity-${label}-${s}`,
    finding: `tf-parity-${label}-${s}`,
    review: `review-parity-${label}-${s}`,
    alignmentAudit: `audit-wa-parity-${label}-${s}`,
    findingAudit: `audit-tf-parity-${label}-${s}`,
    reviewAudit: `audit-review-parity-${label}-${s}`,
  };
  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
     VALUES ($1, $7, 'ops-1', 'test.seed', 'word_alignment', $2),
            ($3, $7, 'ops-1', 'test.seed', 'tajweed_finding', $4),
            ($5, $7, 'teacher-1', 'test.seed', 'teacher_review', $6)`,
    [ids.alignmentAudit, ids.alignment, ids.findingAudit, ids.finding, ids.reviewAudit, ids.review, TENANT],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id)
     VALUES ($1, $4, $2, '1:1:1', 'بسم', 0, 100, 0.9, 'matched', 'model-v0.3', $3)`,
    [ids.alignment, sessionId, ids.alignmentAudit, TENANT],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    confidence: 0.8,
    reviewStatus: "teacher-review-required",
    auditEventId: ids.findingAudit,
  });
  await queryJson(
    `INSERT INTO teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id)
     VALUES ($1, $4, $2, 'teacher-1', 'accepted', 'parity suite seed', $3)`,
    [ids.review, ids.finding, ids.reviewAudit, TENANT],
  );
  return ids;
};

const countRows = async (table, id) =>
  Number((await queryJson(`SELECT count(*)::int AS count FROM ${table} WHERE id = $1`, [id]))[0].count);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Ownership — 1
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:3802 — ml_proxy_rejects_analysis_against_another_learners_session
test("a learner cannot run ML analysis against another in-tenant learner's session", async () => {
  // The attack this blocks: passing someone else's sessionId to ride on THAT session's stored
  // consent. Scoping to the tenant alone is not enough.
  const sessionId = await createSession("learner-1");

  const foreign = await request(api.baseUrl, "/v1/ml/alignments:predict", {
    method: "POST",
    role: "learner",
    userId: "learner-2",
    body: { sessionId, consent: { guardianApproved: true } },
  });
  assert.equal(foreign.status, 403, "a learner must not analyze another learner's session");

  // The owner may — the rejection is scoped to identity, not a blanket block.
  const owner = await request(api.baseUrl, "/v1/ml/alignments:predict", {
    method: "POST",
    role: "learner",
    body: { sessionId, consent: { guardianApproved: true } },
  });
  assert.equal(owner.status, 200, "the session owner may run analysis");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Consent — 1
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:2313 — ml_proxy_overwrites_client_consent_with_the_stored_session_consent
test("STORED session consent overrides whatever the client claims on the analysis request", async () => {
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: RUN_CK_CONSENT_TEST,

      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      // Stored consent WITHHOLDS guardian approval and external ASR.
      consent: {
        audioRetention: "discard",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: false,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(created.status, 200);

  // The client LIES, claiming full consent it never stored.
  const res = await request(api.baseUrl, "/v1/ml/alignments:predict", {
    method: "POST",
    role: "learner",
    body: {
      sessionId: created.body.id,
      consent: {
        guardianApproved: true,
        externalAsrProcessing: true,
        audioRetention: "training-opt-in",
      },
    },
  });
  assert.equal(res.status, 200);

  // The echo mock returns exactly what was forwarded upstream: stored consent must have won.
  assert.equal(res.body.consent.guardianApproved, false, "stored guardian approval must override");
  assert.equal(res.body.consent.externalAsrProcessing, false, "stored external-ASR must override");
  assert.equal(res.body.consent.audioRetention, "discard", "stored retention must override");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Privacy delete — 2
// ════════════════════════════════════════════════════════════════════════════════════════════════

// integration.rs:1413 — privacy_delete_preserves_other_learners_teacher_reviews
test("privacy delete erases the target learner and leaves every other learner intact", async () => {
  const s = uniqueSuffix();
  const target = `learner-privacy-target-${s}`;
  const other = `learner-privacy-other-${s}`;
  await seedLearners(target, other);

  const targetSession = await createSession(target);
  const otherSession = await createSession(other);
  const targetIds = await seedReviewedFinding(targetSession, "target");
  const otherIds = await seedReviewedFinding(otherSession, "other");

  const nodeChunkId = `privacy-${s}`;
  const nodeObjectKey = deriveAudioObjectKey({
    tenantId: TENANT,
    learnerId: target,
    sessionId: targetSession,
    chunkId: nodeChunkId,
  });
  if (api.upstreamUrl) {
    await audioObjectStore.put({
      tenantId: TENANT,
      learnerId: target,
      sessionId: targetSession,
      chunkId: nodeChunkId,
      startMs: 0,
      endMs: 100,
      sampleRate: 16000,
      audioRetention: "discard",
      audioBytes: Buffer.from("private-delete-fixture"),
    });
  }

  const deleted = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: target },
  });
  assert.equal(deleted.status, 200);

  // Exact output on both consolidation boundaries: Rust reports its authenticated ML-compatibility
  // deletion, while the Node target reports the one server-derived key it deleted directly.
  const expectedAudioKeys = api.upstreamUrl
    ? [nodeObjectKey]
    : [...ERASED_KEYS.deletedAudioObjectKeys, ...ERASED_KEYS.deletedMetadataObjectKeys];
  assert.deepEqual(
    deleted.body.audioObjectKeysDeleted,
    expectedAudioKeys,
    "delete must report the exact erased object keys from its active storage boundary",
  );
  assert.deepEqual(
    deleted.body.deletedRecords,
    deleted.body.includedRecords,
    "a delete job's deletedRecords must equal includedRecords",
  );
  assert.ok(deleted.body.deletedRecords.length > 0, "delete must report at least the seeded session");

  assert.equal(await countRows("teacher_reviews", targetIds.review), 0, "target review deleted");
  assert.equal(await countRows("tajweed_findings", targetIds.finding), 0, "target finding deleted");

  // The half that makes this a scoping test rather than a delete test.
  assert.equal(await countRows("teacher_reviews", otherIds.review), 1, "other's review preserved");
  assert.equal(await countRows("tajweed_findings", otherIds.finding), 1, "other's finding preserved");
  assert.equal(await countRows("recitation_sessions", otherSession), 1, "other's session preserved");
});

// integration.rs:1536 — privacy_delete_erases_learner_agent_runs
test("privacy delete erases the learner's agent runs and preserves another learner's", async () => {
  const s = uniqueSuffix();
  const target = `learner-privacy-target-ar-${s}`;
  const other = `learner-privacy-other-ar-${s}`;
  await seedLearners(target, other);

  const createRun = async (learnerId, name) => {
    const res = await request(api.baseUrl, "/v1/agent-runs", {
      method: "POST",
      role: "ops",
      body: {
        name,
        goal: `${name}-goal`,
        status: "queued",
        confidence: 0.5,
        reviewStatus: "draft",
        sources: [],
        learnerId,
      },
    });
    assert.equal(res.status, 200);
    return res.body.id;
  };
  const targetRunId = await createRun(target, "Target Learner Agent Run");
  const otherRunId = await createRun(other, "Other Learner Agent Run");
  const targetRunKey = `agent_run:${targetRunId}`;

  const exported = await request(api.baseUrl, "/v1/privacy/export", {
    method: "POST",
    role: "admin",
    body: { learnerId: target },
  });
  assert.equal(exported.status, 200);
  assert.ok(
    exported.body.includedRecords.includes(targetRunKey),
    `export must include the learner's agent run, got ${JSON.stringify(exported.body.includedRecords)}`,
  );

  const deleted = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: target },
  });
  assert.equal(deleted.status, 200);
  assert.ok(
    deleted.body.deletedRecords.includes(targetRunKey),
    `delete must report deleting the agent run, got ${JSON.stringify(deleted.body.deletedRecords)}`,
  );

  assert.equal(await countRows("agent_runs", targetRunId), 0, "target agent run deleted");
  assert.equal(await countRows("agent_runs", otherRunId), 1, "other learner's agent run preserved");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Withheld feedback — P3.2
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * integration.rs:5054 — ml_tajweed_predict_redacts_unreviewed_findings_for_a_learner
 *
 * Black-box, and that is the whole point: the property is about what crosses the wire to a learner's
 * device. Everything this route returns is freshly computed and `ai-suggested`, so no human has seen
 * any of it — and it was being sent in full, with the client trusted to hide it. Client-side hiding
 * is a display choice, not an authorization boundary.
 *
 * Run through the Node shell as well (PARITY_THROUGH_SHELL=1 with this route in NODE_API_PORTED) to
 * pin `redactWithheldFindings` in server/src/routes/ml-proxy.mjs against the Rust original.
 */
test("ML tajweed predict: a learner receives no unreviewed judgement", async () => {
  const sessionId = await createSession("learner-1");

  const res = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    body: { sessionId, quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "x" } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const findings = res.body.findings;
  assert.equal(findings.length, 2, "the count must survive redaction — the panel renders from it");

  for (const finding of findings) {
    assert.equal(finding.reviewStatus, "ai-suggested");
    assert.equal(finding.withheld, true);
    for (const field of ["rule", "severity", "explanation", "wordId"]) {
      assert.equal(finding[field], "", `predict leaked \`${field}\` to the learner`);
    }
    assert.equal(finding.confidence, 0);
    assert.deepEqual(finding.sources, []);
  }
});

test("ML tajweed predict: ops analysing a session get the findings whole", async () => {
  // NOT "teacher": proxy_ml allows the session owner or ANALYSIS_STAFF (admin/ops) only, so a
  // teacher is 403 here long before redaction is reached.
  const sessionId = await createSession("learner-1");

  const res = await request(api.baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "ops",
    body: { sessionId, quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "x" } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const unreviewed = res.body.findings.find((f) => f.reviewStatus === "ai-suggested");
  assert.equal(unreviewed.rule, "ghunnah", "staff cannot act on what was redacted from them");
  assert.equal(unreviewed.explanation, "Apply ghunnah on the noon sakina.");
});

// Registered last: node:test runs `after` hooks in registration order, so this drains the
// rows once the hooks above have stopped the services still able to write them.
after(async () => {
  let left = 0;
  left += await purgeSessionsByChecksum(RUN_CK_PRIVACY);
  left += await purgeSessionsByChecksum(RUN_CK_CONSENT_TEST);
  assert.equal(left, 0, `teardown left ${left} session(s) behind`);
});

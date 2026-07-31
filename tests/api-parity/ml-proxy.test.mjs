import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import {
  TENANT,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  uniqueSuffix,
} from "./lib/harness.mjs";

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

let api;
let mock;

before(async () => {
  mock = await startMockUpstream(({ path, body }) => {
    // integration.rs:1393 — the privacy-delete mock reports erased object keys.
    if (path === "/v1/privacy/delete") return { status: 200, body: ERASED_KEYS };
    // integration.rs:2275 — the echo mock returns exactly what the proxy FORWARDED, which is the
    // only way to see whether stored consent overrode the client's claim.
    return { status: 200, body };
  });
  api = await startApi({ env: { ML_INFERENCE_URL: mock.url } });
});

after(async () => {
  await api?.stop();
  await mock?.stop();
});

const seedLearners = async (...ids) => {
  for (const id of ids) {
    await queryJson(
      `INSERT INTO users (id, tenant_id, display_name, role, language)
       VALUES ($1, $2, 'Parity Privacy', 'learner', 'ckb')`,
      [id, TENANT],
    );
  }
};

const createSession = async (learnerId) => {
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "admin",
    body: {
      learnerId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: "fnv1a32:privacy-scope",
      modelVersion: "model-v0.3",
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
  await queryJson(
    `INSERT INTO tajweed_findings
       (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
        source_refs, model_version_id, audit_event_id)
     VALUES ($1, $4, $2, 'Ghunnah', 'warning', 0.8, 'x', 'teacher-review-required', '[]'::jsonb,
             'model-v0.3', $3)`,
    [ids.finding, ids.alignment, ids.findingAudit, TENANT],
  );
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
      sourceChecksum: "fnv1a32:consent-test",
      modelVersion: "model-v0.3",
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

  const deleted = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: target },
  });
  assert.equal(deleted.status, 200);

  // The EXACT keys the mock reported, not "some non-empty list": a bug that fabricated a
  // placeholder list would still pass a non-empty check.
  assert.deepEqual(
    deleted.body.audioObjectKeysDeleted,
    [...ERASED_KEYS.deletedAudioObjectKeys, ...ERASED_KEYS.deletedMetadataObjectKeys],
    "delete must report the exact erased object keys from the ML service",
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  reservePort,
  startApi,
  uniqueSuffix,
} from "../api-parity/lib/harness.mjs";

/**
 * The erasure receipt must name what the erasure actually destroyed.
 *
 * `privacy_jobs.deleted_records` is the record that the request was honoured — `privacy.rs:56` calls
 * it "the authoritative audit trail that the audio was in fact deleted", and ADR-0061 leans on it as
 * the reason the receipt itself is retained after an erasure.
 *
 * It was built from five tables while the cascade deletes from twelve, because `deleted_ids` is a
 * clone of the export's `included_ids`. Measured on a learner seeded with one consent record, one
 * session, one alignment and one finding — all four rows gone afterwards, and the receipt named ONE:
 *
 *     receipt deletedRecords: ["s-4150-2-2de51769"]
 *
 * A learner or a regulator asking "what did you delete?" was told about the recitation and not about
 * the assessments made of it, the word-level record of how they recited, or the consent they gave.
 *
 * ── Why this is a behavioural test and not a source scan ────────────────────────────────────────
 * `erasure-coverage.test.mjs` already diffs the schema against the handler's `DELETE FROM` list, and
 * a second static check would inherit the same blind spot: both would be reading the same file. The
 * question here is what the RECEIPT says after a real erasure, which only a real erasure answers.
 *
 * ── Identifiers, never content ──────────────────────────────────────────────────────────────────
 * Every entry is an id. Listing a finding's id discloses no judgement, so nothing here crosses the
 * ADR-0028 learner gate — the count of pending notes is already something both clients render.
 *
 * Requires a live Postgres and a real ml-inference: the erasure aborts with a 502 when the audio
 * service is unreachable (deliberately — "no success while audio survives"), and a test that took
 * that 502 for an answer would prove the abort path while claiming to prove the receipt.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ADR-0044 retired `services/ml-inference` into `server/`. The compatibility-ingress harness is
// what that entrypoint became: same ML_INFERENCE_PORT / ML_API_KEY / AUDIO_STORAGE_DIR contract,
// same two prediction endpoints, plus /health and /ready.
const ML_ENTRY = join(root, "tests/inference/lib/worker-compatibility-harness.mjs");
const ML_KEY = "erasure-receipt-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ml;
let storageDir;
let api;
let baseUrl;
let learnerId;
let ids;

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "erasure-receipt-"));
  const mlPort = await reservePort();
  ml = spawn(process.execPath, [ML_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      ML_INFERENCE_PORT: String(mlPort),
      AUDIO_STORAGE_DIR: storageDir,
      ML_API_KEY: ML_KEY,
      ALLOW_INSECURE_DEFAULTS: "",
      ALLOW_INSECURE_SECRETS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const mlUrl = `http://127.0.0.1:${mlPort}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${mlUrl}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("ml-inference never came up");
    await sleep(50);
  }

  api = await startApi({ env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY } });
  baseUrl = api.upstreamUrl ?? api.baseUrl;
  ({ learnerId, ids } = await seedOneOfEach());
});

after(async () => {
  await api?.stop();
  if (ml && ml.exitCode === null) {
    ml.kill("SIGTERM");
    const hard = Date.now() + 5_000;
    while (ml.exitCode === null && Date.now() < hard) await sleep(25);
    if (ml.exitCode === null) ml.kill("SIGKILL");
  }
  if (storageDir) rmSync(storageDir, { recursive: true, force: true });

  if (learnerId) {
    // The erasure removes the learner's rows; these are the ones it deliberately retains.
    await queryJson("DELETE FROM privacy_jobs WHERE learner_id = $1", [learnerId]).catch(() => {});
    await queryJson("DELETE FROM audit_events WHERE actor_id = $1", [learnerId]).catch(() => {});
    await queryJson("DELETE FROM users WHERE id = $1", [learnerId]).catch(() => {});
  }
});

/**
 * A learner of this run's own, holding one row in each category the receipt should name.
 *
 * Its own learner because this test ERASES the subject — pointing it at a seeded learner would
 * destroy fixture data every other test in the repository reads.
 */
async function seedOneOfEach() {
  const reg = await request(baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: TENANT,
      displayName: "erasure receipt subject",
      role: "learner",
      language: "ckb",
      email: `erasure-receipt-${uniqueSuffix()}@example.test`,
      password: "ErasureReceipt1234",
    },
  });
  assert.equal(reg.status, 200, `creating the subject failed: ${reg.text}`);
  const learner = reg.body.id ?? reg.body.userId;

  const sx = uniqueSuffix();
  const row = {
    audit: `audit-er-${sx}`,
    consent: `consent-er-${sx}`,
    session: `session-er-${sx}`,
    alignment: `wa-er-${sx}`,
    finding: `tf-er-${sx}`,
  };
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [row.audit, TENANT, learner],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, 'discard', true, false, true, 'pilot-v1', $4)`,
    [row.consent, TENANT, learner, row.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:receipt', $4, 'guided-recite', 'p', false, 0.9,
             'draft', now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [row.session, TENANT, learner, model.id, row.consent, row.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 0, 100, 0.9, 'matched', $5, $6, 'client-reported')`,
    [row.alignment, TENANT, row.session, word.id, model.id, row.audit],
  );
  // 0030 narrowed analysis_basis to ('text-rule','acoustic') and a trigger requires an acoustic
  // finding to reference release-eligible evaluation evidence, so this can no longer be a bare
  // INSERT. The harness helper seeds the declared evidence and the finding together, which is what
  // every other acoustic fixture in the suite already uses.
  await insertDeclaredTestAcousticFinding({
    id: row.finding,
    alignmentId: row.alignment,
    rule: "ghunnah",
    severity: "warning",
    confidence: 0.9,
    explanation: "e",
    reviewStatus: "teacher-review-required",
    auditEventId: row.audit,
  });

  return { learnerId: learner, ids: row };
}

/** What the learner actually holds, counted through the same joins the cascade deletes by. */
async function remainingRows() {
  const one = async (sql) => (await queryJson(sql, [learnerId]))[0].n;
  return {
    consent_records: await one("SELECT count(*)::int AS n FROM consent_records WHERE user_id = $1"),
    recitation_sessions: await one(
      "SELECT count(*)::int AS n FROM recitation_sessions WHERE learner_id = $1",
    ),
    word_alignments: await one(
      `SELECT count(*)::int AS n FROM word_alignments wa
         JOIN recitation_sessions rs ON rs.id = wa.session_id WHERE rs.learner_id = $1`,
    ),
    tajweed_findings: await one(
      `SELECT count(*)::int AS n FROM tajweed_findings tf
         JOIN word_alignments wa ON wa.id = tf.alignment_id
         JOIN recitation_sessions rs ON rs.id = wa.session_id WHERE rs.learner_id = $1`,
    ),
  };
}

let receipt;

test("the subject really holds one row of each category before anything is erased", async () => {
  // The precondition IS the test's meaning. If the seed were wrong, every assertion below would be
  // satisfied by an erasure that had nothing to erase and a receipt that named nothing.
  assert.deepEqual(await remainingRows(), {
    consent_records: 1,
    recitation_sessions: 1,
    word_alignments: 1,
    tajweed_findings: 1,
  });
});

test("the erasure destroys all four categories", async () => {
  const res = await request(baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId },
  });
  assert.equal(
    res.status,
    200,
    `the erasure did not succeed: ${res.status} ${res.text}. A 502 here means ml-inference was ` +
      `unreachable and the DB was deliberately left untouched — this test then proves the abort ` +
      `path, not the receipt.`,
  );
  receipt = res.body;

  assert.deepEqual(await remainingRows(), {
    consent_records: 0,
    recitation_sessions: 0,
    word_alignments: 0,
    tajweed_findings: 0,
  });
});

test("the receipt names every row the erasure destroyed", async () => {
  // THE assertion. Before the fix this listed the session and nothing else, while four rows had
  // gone — a receipt that under-reports what it destroyed is worse than no receipt, because it
  // reads as a complete account.
  assert.ok(receipt, "the erasure test must run first");
  const listed = JSON.stringify(receipt.deletedRecords ?? []);

  const missing = Object.entries(ids)
    .filter(([category]) => category !== "audit") // deliberately retained; ADR-0061
    .filter(([, id]) => !listed.includes(id))
    .map(([category, id]) => `${category} (${id})`);

  assert.deepEqual(
    missing,
    [],
    `these rows were deleted and the receipt does not mention them:\n  ${missing.join("\n  ")}\n` +
      `Receipt: ${listed}`,
  );
});

test("the receipt is a list of identifiers and carries no learner-facing content", async () => {
  // The other direction, and the reason this fix is safe. Ids may name a withheld finding; the
  // judgement itself may not travel. A receipt that started carrying explanations would hand the
  // learner exactly what ADR-0028's gate exists to withhold.
  assert.ok(receipt);
  const listed = JSON.stringify(receipt.deletedRecords ?? []).toLowerCase();
  for (const leak of ["ghunnah", "explanation", "confidence", "severity", "warning"]) {
    assert.ok(
      !listed.includes(leak),
      `the receipt carries "${leak}", which is content rather than an identifier: ${listed}`,
    );
  }
});

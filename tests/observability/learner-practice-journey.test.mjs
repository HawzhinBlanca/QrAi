import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TENANT,
  queryJson,
  request,
  reservePort,
  startApi,
  uniqueSuffix,
} from "../api-parity/lib/harness.mjs";

/**
 * @journey: learner-practice
 *
 * A learner records a session, the model analyses it, and what comes back is BOTH kept and
 * withheld: written down so a teacher can review it, and not shown to the learner until one has.
 *
 * ── The two defects this shape has already produced ─────────────────────────────────────────────
 * 1. The tajweed route returned findings and stored none. Every component was correct; the learner
 *    saw feedback that no teacher could ever review because it existed only for the length of one
 *    HTTP response.
 * 2. The same route sent the full unreviewed analysis to the learner's device — every rule,
 *    severity, explanation and confidence — with the browser trusted to hide it. `curl` with the
 *    learner's own token read all of it.
 *
 * Both are sev-1 under `docs/readiness/JOURNEYS.md`, both were invisible to every component test,
 * and both live in the gap between "ml-inference returned findings" and "the learner's next request
 * is answered correctly". That gap is this journey.
 *
 * `tests/api-parity/ml-proxy.test.mjs` drives this route against a MOCK. The mock returns whatever
 * the test tells it to, so it cannot show what the real analyser produces or that the persistence
 * survives it. This runs the REAL ml-inference.
 *
 * Requires a live Postgres. Creates its own learner and session and removes them.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ADR-0044 retired `services/ml-inference` into `server/`. The compatibility-ingress harness is
// what that entrypoint became: same ML_INFERENCE_PORT / ML_API_KEY / AUDIO_STORAGE_DIR contract,
// same two prediction endpoints, plus /health and /ready.
const ML_ENTRY = join(root, "tests/inference/lib/worker-compatibility-harness.mjs");
const ML_KEY = "learner-journey-ml-key";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ml;
let mlUrl;
let mlStderr = "";
let storageDir;
let api;
let baseUrl;
let learnerId;
let sessionId;

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "learner-journey-"));
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
  ml.stderr.on("data", (d) => {
    mlStderr += `[ml] ${d}`;
  });

  mlUrl = `http://127.0.0.1:${mlPort}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${mlUrl}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`ml-inference never came up\n${mlStderr}`);
    await sleep(50);
  }

  api = await startApi({ env: { ML_INFERENCE_URL: mlUrl, ML_API_KEY: ML_KEY } });
  baseUrl = api.baseUrl;

  // A learner created for this run. The privacy journey learned this the hard way: pointing a test
  // that writes progress and findings at a seeded learner mutates fixture data every other test in
  // the repository reads.
  learnerId = await createLearner();
  sessionId = await createSession(learnerId);
  await seedAlignments(sessionId);
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
    // FK-safe, and scoped to the learner this file created — never a pattern.
    await queryJson(
      `DELETE FROM tajweed_findings WHERE alignment_id IN
         (SELECT id FROM word_alignments WHERE session_id IN
            (SELECT id FROM recitation_sessions WHERE learner_id = $1))`,
      [learnerId],
    );
    await queryJson(
      `DELETE FROM word_alignments WHERE session_id IN
         (SELECT id FROM recitation_sessions WHERE learner_id = $1)`,
      [learnerId],
    );
    await queryJson("DELETE FROM learner_progress WHERE learner_id = $1", [learnerId]);
    await queryJson("DELETE FROM recitation_sessions WHERE learner_id = $1", [learnerId]);
    await queryJson("DELETE FROM consent_records WHERE user_id = $1", [learnerId]);
    // `audit_events.actor_id` references `users`, so the trail has to go before the person does.
    // Only rows this learner is the actor of — the register is not otherwise touched.
    await queryJson("DELETE FROM audit_events WHERE actor_id = $1", [learnerId]);
    await queryJson("DELETE FROM users WHERE id = $1", [learnerId]);
  }
});

async function createLearner() {
  const res = await request(baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: TENANT,
      displayName: "learner practice journey",
      role: "learner",
      language: "ckb",
      email: `learner-journey-${uniqueSuffix()}@example.test`,
      password: "LearnerJourney1234",
    },
  });
  assert.equal(res.status, 200, `creating a learner failed: ${res.text}`);
  const id = res.body.id ?? res.body.userId;
  assert.ok(id, `no user id in ${res.text}`);
  return id;
}

async function createSession(learner) {
  const res = await request(baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: learner,
    body: {
      learnerId: learner,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: "fnv1a32:learnerjourney",
      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: {
        audioRetention: "teacher-review",
        anonymizedLearning: true,
        externalAsrProcessing: false,
        guardianApproved: true,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(res.status, 200, `creating a session failed: ${res.text}`);
  const id = res.body.id ?? res.body.sessionId;
  assert.ok(id, `no session id in ${res.text}`);
  return id;
}

/**
 * The word-level alignment a finalized recitation leaves behind.
 *
 * Seeded rather than produced by `/finalize`, which would pull the ASR service into this journey.
 * The alignment WRITE path has its own coverage (`tajweed-persistence-effects.test.mjs`,
 * `ml-asr-proxy-parity.test.mjs`); what is unproven and belongs here is what happens to the
 * analysis afterwards.
 *
 * It is not optional scaffolding. `persist_tajweed_findings` returns early when a session has no
 * alignments — "there is no evidence a finding could point at" (ml_proxy.rs:352), deliberately and
 * with a log line. A journey that skipped this step would measure that early return and read it as
 * a persistence failure. It did, on the first run: 38 findings returned, 0 stored.
 */
async function seedAlignments(session) {
  const words = await queryJson(
    "SELECT id FROM canonical_words WHERE ayah_id = '1:1' ORDER BY id LIMIT 4",
  );
  assert.ok(words.length > 0, "the canonical corpus has no words for 1:1 to align against");
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [audit] = await queryJson(
    "SELECT audit_event_id AS id FROM recitation_sessions WHERE id = $1",
    [session],
  );
  let i = 0;
  for (const word of words) {
    i += 1;
    await queryJson(
      `INSERT INTO word_alignments
         (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
          model_version_id, audit_event_id, transcript_source)
       VALUES ($1, $2, $3, $4, 'x', $5, $6, 0.9, 'matched', $7, $8, 'client-reported')`,
      [`wa-lj-${session}-${i}`, TENANT, session, word.id, i * 100, i * 100 + 90, model.id, audit.id],
    );
  }
}

/** The learner's own consent is on the record before anything is analysed. */
test("the session starts with the learner's consent recorded against it", async () => {
  const [row] = await queryJson(
    `SELECT cr.audio_retention, cr.guardian_approved
       FROM recitation_sessions rs
       JOIN consent_records cr ON cr.id = rs.consent_record_id
      WHERE rs.id = $1`,
    [sessionId],
  );
  assert.ok(row, "a session exists with no consent record attached to it (sev-1)");
  assert.equal(row.audio_retention, "teacher-review");
  assert.equal(row.guardian_approved, true);
});

test("the analysis is recorded as instruction, and never as a learner finding", async () => {
  const res = await request(baseUrl, "/v1/ml/tajweed-findings:predict", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      tenantId: TENANT,
      sessionId,
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      words: [],
    },
  });
  assert.equal(res.status, 200, `the analysis failed: ${res.status} ${res.text}`);

  // ── What this test used to assert, and why it now asserts the opposite ────────────────────────
  //
  // It used to require that findings reach `tajweed_findings`: "a response is not a record", and a
  // finding that lives only for the length of one HTTP response can never be reviewed. That was
  // right about the deterministic analyser of the time, which wrote every rule it matched as
  // `analysis_basis = 'canonical-text'`.
  //
  // ADR-0044 (#388) drew the instruction/performance boundary that migration 0030 enforces: a rule
  // that applies at a position in the passage is TRUE OF THE TEXT and identical for every learner
  // who ever recites it. Calling that a finding about this child's recitation was the defect. So
  // the deterministic analyser now returns `annotations` (analysisBasis "text-rule",
  // instructional), `findings` is empty, and only acoustic output backed by a released evaluation
  // may be stored — 0030's CHECK does not even admit any other basis.
  //
  // The original subject survives, inverted: a response is still not a record, so this asserts that
  // the thing which IS the record — the alignment — was written, and that nothing talked its way
  // into the performance table on the strength of a text rule.
  const returned = res.body.findings ?? [];
  assert.deepEqual(
    returned,
    [],
    `the deterministic analyser returned ${returned.length} learner finding(s); canonical rules are ` +
      "instruction and cannot support a claim about how THIS learner recited (0030)",
  );

  const annotations = res.body.annotations ?? [];
  assert.ok(
    annotations.length > 0,
    `the analysis returned neither findings nor annotations: ${res.text.slice(0, 400)}`,
  );
  for (const a of annotations) {
    assert.equal(a.analysisBasis, "text-rule", `an annotation claimed basis ${JSON.stringify(a.analysisBasis)}`);
    assert.equal(a.instructional, true, "an annotation was not marked instructional");
  }

  // The boundary, checked where it actually matters: in the table, not in the payload.
  const stored = await queryJson(
    `SELECT tf.id, tf.review_status, tf.analysis_basis
       FROM tajweed_findings tf
       JOIN word_alignments wa ON wa.id = tf.alignment_id
      WHERE wa.session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(
    stored.map((f) => f.analysis_basis),
    [],
    "a text-rule analysis wrote rows into tajweed_findings — that is the pre-0030 defect returning",
  );

  // "A response is not a record" — anchored on the row that IS the record for this journey. Without
  // this the test would pass just as well if the session had stored nothing at all.
  const alignedWords = await queryJson(
    "SELECT word_id FROM word_alignments WHERE session_id = $1",
    [sessionId],
  );
  assert.ok(
    alignedWords.length > 0,
    "the session produced no stored alignments, so there is nothing for a teacher to review and " +
      "nothing a later acoustic finding could anchor to",
  );

  // Any row that does appear here later (a real acoustic model) is unreviewed BY CONSTRUCTION — no
  // human has seen it. Kept so the guarantee is already in place when findings start being written.
  for (const f of stored) {
    assert.ok(
      f.review_status === "ai-suggested" || f.review_status === "teacher-review-required",
      `a freshly analysed finding was stored as "${f.review_status}" — no human has looked at it`,
    );
  }
});

test("the learner is told notes are pending, and is told nothing else", async () => {
  const res = await request(baseUrl, `/v1/recitation-sessions/${sessionId}/tajweed-findings`, {
    role: "learner",
    userId: learnerId,
  });
  assert.equal(res.status, 200, `the learner cannot read their own session: ${res.text}`);

  const findings = Array.isArray(res.body) ? res.body : (res.body.findings ?? []);
  for (const f of findings) {
    // Every one of these is fresh model output, so every one must be redacted. `confidence: 0` and
    // `sources: []` are not filler — they make a redacted row fail the gate a second time, so a
    // client that never learns what "withheld" means still cannot render one as feedback.
    assert.equal(
      f.confidence,
      0,
      `an unreviewed finding carried its confidence to the learner (sev-1): ${JSON.stringify(f)}`,
    );
    assert.deepEqual(
      f.sources ?? [],
      [],
      `an unreviewed finding carried its sources to the learner (sev-1): ${JSON.stringify(f)}`,
    );
    assert.ok(
      !f.explanation,
      `an unreviewed finding carried its explanation to the learner (sev-1): ${JSON.stringify(f)}`,
    );
  }
});

test("staff see the same analysis whole — the redaction is per-role, not per-row", async () => {
  // The other direction. A redaction that applied to everyone would pass every assertion above and
  // make the finding unreviewable, which is defect #1 again wearing a different hat.
  const staff = await request(baseUrl, `/v1/recitation-sessions/${sessionId}/tajweed-findings`, {
    role: "teacher",
  });
  assert.equal(staff.status, 200, `a teacher cannot read the session: ${staff.text}`);

  const findings = Array.isArray(staff.body) ? staff.body : (staff.body.findings ?? []);
  const learnerView = await request(
    baseUrl,
    `/v1/recitation-sessions/${sessionId}/tajweed-findings`,
    { role: "learner", userId: learnerId },
  );
  const learnerFindings = Array.isArray(learnerView.body)
    ? learnerView.body
    : (learnerView.body.findings ?? []);

  assert.equal(
    findings.length,
    learnerFindings.length,
    "the learner must see the same NUMBER of pending notes as staff — the count is what tells " +
      "them a review is coming; only the content is withheld",
  );
  // Compared on the EXPLANATION, not on confidence. The rule-based analyser legitimately emits
  // findings at confidence 0, so "confidence > 0" would have been a claim about the model's output
  // rather than about the redaction — it failed here for exactly that reason. The explanation is
  // what the redaction removes and what a reviewer needs.
  if (findings.length > 0) {
    assert.ok(
      findings.some((f) => typeof f.explanation === "string" && f.explanation.length > 0),
      "staff received the redacted copy — nobody can review what nobody can read",
    );
    assert.ok(
      learnerFindings.every((f) => !f.explanation),
      "the learner received an explanation staff are only just about to review (sev-1)",
    );
  }
});

test("the learner's practice is recorded and reads back", async () => {
  // The outcome the learner came for that does NOT depend on the model being right.
  const write = await request(baseUrl, "/v1/learner/progress", {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: { quality: 5, ayahRef: "1:1" },
  });
  assert.equal(write.status, 200, `recording practice failed: ${write.status} ${write.text}`);

  const read = await request(baseUrl, "/v1/learner/progress", {
    role: "learner",
    userId: learnerId,
  });
  assert.equal(read.status, 200, `reading progress back failed: ${read.text}`);

  // `/v1/learner/progress` answers with a SUMMARY — mastery, streak, totalSessions, nextReviewAt —
  // not a per-ayah list. (Asserting the ayah ref appeared in the body was a guess, and it failed
  // against a response that was in fact correct.) The summary must nonetheless MOVE, or the learner
  // is shown a dashboard that ignores what they just did.
  assert.ok(
    Number(read.body.totalSessions) >= 1,
    `the learner practised and their progress still reports ${read.body.totalSessions} sessions ` +
      `(sev-2 — practice that is not saved is practice they have to repeat): ${read.text}`,
  );
  assert.ok(read.body.nextReviewAt, "a recorded review must schedule the next one");

  const [row] = await queryJson(
    "SELECT repetitions, interval_days FROM learner_progress WHERE learner_id = $1 AND ayah_ref = $2",
    [learnerId, "1:1"],
  );
  assert.ok(row, "no progress row was written for the ayah the learner just practised");
  assert.ok(
    Number(row.repetitions) >= 1,
    `the SM-2 review was not counted: repetitions=${row.repetitions}`,
  );
});

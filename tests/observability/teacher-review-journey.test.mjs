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
} from "../api-parity/lib/harness.mjs";

/**
 * @journey: teacher-review
 *
 * A teacher finds the session waiting for them, HEARS the actual recitation, and their decision is
 * written down and audited.
 *
 * ── Why the existing audio test is not this ─────────────────────────────────────────────────────
 * `tests/api-parity/audio-playback-parity.test.mjs` covers authorization, the consent decision, the
 * audit row and the proxying — against a MOCK ml-inference that returns the string
 * `"recitation-bytes"` whatever it is asked. It says so itself. That proves platform-api asks the
 * right question; it cannot prove an answer comes back.
 *
 * `services/ml-inference/chunk-overwrite.test.mjs` proves ml-inference stores and returns bytes,
 * driven directly, with no platform-api involved.
 *
 * The join is unproven, and it is the whole feature: a teacher reviewing a recitation they cannot
 * hear is the exact defect ADR-0037 was written after (#403 — the surface fetched the gateway's
 * WebSocket path over HTTP and 404'd on every session, indistinguishable from a learner having
 * exercised their right to erasure). Both halves were individually correct then, too.
 *
 * So this starts the REAL ml-inference, stores REAL bytes through it, and asserts the teacher gets
 * THOSE bytes back — content, not just a 200.
 *
 * Requires a live Postgres. Seeds its own rows and removes exactly those.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ML_ENTRY = join(root, "services/ml-inference/server.mjs");
const ML_KEY = "teacher-journey-ml-key";

/** Distinctive bytes: a 200 carrying somebody else's audio must not be able to pass. */
const RECITATION = Buffer.from("JOURNEY-RECITATION-BYTES-0123456789");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ml;
let mlUrl;
let mlStderr = "";
let storageDir;
let api;
let baseUrl;
const seeded = [];

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "teacher-journey-"));
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

  for (const ids of seeded.reverse()) {
    await queryJson("DELETE FROM teacher_reviews WHERE finding_id = $1", [ids.finding]);
    await queryJson("DELETE FROM tajweed_findings WHERE id = $1", [ids.finding]);
    await queryJson("DELETE FROM audio_chunks WHERE id = $1", [ids.chunk]);
    await queryJson("DELETE FROM word_alignments WHERE id = $1", [ids.alignment]);
    await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [ids.session]);
    await queryJson("DELETE FROM consent_records WHERE id = $1", [ids.consent]);
    await queryJson("DELETE FROM audit_events WHERE id = $1", [ids.audit]);
  }
});

/** Put real bytes on ml-inference's disk, the way the realtime gateway does. */
async function storeRecitation({ learnerId, sessionId, chunkId, retention }) {
  const res = await fetch(`${mlUrl}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": ML_KEY },
    body: JSON.stringify({
      tenantId: TENANT,
      learnerId,
      sessionId,
      chunkId,
      startMs: 0,
      endMs: 1400,
      sampleRate: 16000,
      audioRetention: retention,
      audioBase64: RECITATION.toString("base64"),
    }),
  });
  assert.equal(res.status, 200, `storing the recitation failed: ${await res.text()}`);
  return `${TENANT}/${learnerId}/${chunkId}.bin`;
}

/**
 * A session that needs review, with a finding, and (optionally) a stored recitation.
 *
 * `audio_chunks` is still written by nothing in production — the index half is unbuilt and recorded
 * as such in `audio-playback-parity.test.mjs`. The row is seeded here for the same reason and with
 * the same honesty: what this journey proves is the read path from teacher to disk, not that the
 * gateway writes the index.
 */
async function seedReviewable({ label, retention = "teacher-review", withAudio = true }) {
  // Backdated deliberately. The queue serves awaiting findings OLDEST first under a LIMIT, and the
  // shared development database already holds thousands of them, so a session stamped `now()` sorts
  // to the very back and falls off the page — which would make the two queue assertions below fail
  // for a reason that has nothing to do with the journey. `review-parity.test.mjs` backdates its
  // seeds for the same reason. The age is a fixture concern; nothing here asserts on it.
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const ids = {
    audit: `audit-t-${label}-${suffix}`,
    consent: `consent-t-${label}-${suffix}`,
    session: `session-t-${label}-${suffix}`,
    alignment: `wa-t-${label}-${suffix}`,
    finding: `tf-t-${label}-${suffix}`,
    chunk: `chunk-t-${label}-${suffix}`,
  };

  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [model] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  const [word] = await queryJson("SELECT id FROM canonical_words WHERE ayah_id = '1:1' LIMIT 1");

  await queryJson(
    `INSERT INTO audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES ($1, $2, $3, 'test.seed', 'test', $1, '{}'::jsonb)`,
    [ids.audit, TENANT, learner.id],
  );
  await queryJson(
    `INSERT INTO consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning,
       external_asr_processing, guardian_approved, consent_version, audit_event_id)
     VALUES ($1, $2, $3, $4, true, false, true, 'pilot-v1', $5)`,
    [ids.consent, TENANT, learner.id, retention, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1,"display":"Al-Fatihah 1:1"}'::jsonb,
             'fnv1a32:tjourney', $4, 'guided-recite', 'p', false, 0.9, 'teacher-review-required',
             now() - interval '18 years', 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 600, 1400, 0.9, 'needs-review', $5, $6, 'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  await queryJson(
    `INSERT INTO tajweed_findings
       (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
        source_refs, model_version_id, audit_event_id, analysis_basis)
     VALUES ($1, $2, $3, 'ghunnah', 'warning', 0.88, 'Hold the nasalization.',
             'teacher-review-required',
             '[{"id":"src-t","title":"Tajweed reference","citation":"Rule 1"}]'::jsonb,
             $4, $5, 'canonical-text')`,
    [ids.finding, TENANT, ids.alignment, model.id, ids.audit],
  );

  let objectKey = null;
  if (withAudio) {
    objectKey = await storeRecitation({
      learnerId: learner.id,
      sessionId: ids.session,
      chunkId: ids.chunk,
      retention,
    });
    await queryJson(
      `INSERT INTO audio_chunks
         (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status, object_key,
          audit_event_id)
       VALUES ($1, $2, $3, 'ev', 600, 1400, 16000, 'aligned', $4, $5)`,
      [ids.chunk, TENANT, ids.session, objectKey, ids.audit],
    );
  }

  seeded.push(ids);
  return { ...ids, learnerId: learner.id, objectKey };
}

const audioAuditRowsFor = (findingId) =>
  queryJson(
    `SELECT action, actor_id, metadata FROM audit_events
      WHERE tenant_id = $1 AND subject_id = $2 AND action LIKE '%audio%'`,
    [TENANT, findingId],
  );

/**
 * Page the staff findings list until the finding turns up.
 *
 * `/v1/tajweed-findings` serves undecided findings first under `LIMIT 200 OFFSET`, and the shared
 * development database holds thousands of them. Paging is not flake-tolerance — an unbounded search
 * would be. The bound is explicit and the failure says how far it looked.
 */
async function findInStaffQueue(findingId, maxPages = 12) {
  for (let page = 0; page < maxPages; page += 1) {
    const res = await request(baseUrl, `/v1/tajweed-findings?offset=${page * 200}`, {
      role: "teacher",
    });
    assert.equal(res.status, 200, `the teacher cannot read the findings queue: ${res.text}`);
    const rows = Array.isArray(res.body) ? res.body : (res.body.findings ?? []);
    if (rows.length === 0) return { found: false, pages: page + 1, exhausted: true };
    if (rows.some((f) => f.id === findingId)) return { found: true, pages: page + 1 };
  }
  return { found: false, pages: maxPages, exhausted: false };
}

test("the work waiting for a teacher is findable in the staff queue", async () => {
  const ids = await seedReviewable({ label: "queued" });

  const hit = await findInStaffQueue(ids.finding);
  assert.ok(
    hit.found,
    `a finding marked teacher-review-required is not in the staff queue after ${hit.pages} ` +
      `page(s) (sev-2 — the teacher never learns there is work). Looked for ${ids.finding}. ` +
      `${hit.exhausted ? "The queue ran out before it was found." : "The page bound was reached."}`,
  );
});

test("the teacher hears the recitation that was actually stored", async () => {
  const ids = await seedReviewable({ label: "audible" });

  const res = await request(baseUrl, `/v1/tajweed-findings/${ids.finding}/audio`, {
    role: "teacher",
  });
  assert.equal(
    res.status,
    200,
    `the teacher could not fetch the recitation they are judging: ${res.status} ${res.text}`,
  );

  const returned = Buffer.from(res.body.audioBase64 ?? "", "base64");
  assert.ok(
    returned.equals(RECITATION),
    `the bytes a teacher received are not the bytes that were stored. This is the assertion the ` +
      `mock-backed parity test cannot make: it returns a fixed string whatever it is asked. ` +
      `Got ${returned.length} bytes, expected ${RECITATION.length}.`,
  );
});

test("every fetch of a recitation is audited before the bytes move", async () => {
  // ADR-0037's actual promise. A teacher listening to a learner's voice is an event a learner is
  // entitled to see in their own privacy export.
  const ids = await seedReviewable({ label: "audited" });

  assert.deepEqual(
    await audioAuditRowsFor(ids.finding),
    [],
    "precondition: nothing should be audited before the teacher asks",
  );

  const res = await request(baseUrl, `/v1/tajweed-findings/${ids.finding}/audio`, {
    role: "teacher",
  });
  assert.equal(res.status, 200);

  const rows = await audioAuditRowsFor(ids.finding);
  assert.equal(rows.length, 1, `expected exactly one audio audit row, got ${rows.length}`);
  assert.equal(rows[0].actor_id, "teacher-1", "the audit must name who listened");
});

test("a discarded recitation is refused as gone, and still audited", async () => {
  // The outcome ADR-0037 exists to keep distinct from a bug. `discard` means the learner asked for
  // their voice to be destroyed; a 404 here would read as "we lost it", which is what the teacher
  // surface used to show for a route that never existed.
  const ids = await seedReviewable({ label: "discarded", retention: "discard", withAudio: false });

  const res = await request(baseUrl, `/v1/tajweed-findings/${ids.finding}/audio`, {
    role: "teacher",
  });
  assert.equal(
    res.status,
    410,
    `a discarded recording must be 410 Gone, not ${res.status} — a teacher has to be able to tell ` +
      `"destroyed at the learner's request" from "we cannot find it".`,
  );

  const rows = await audioAuditRowsFor(ids.finding);
  assert.equal(
    rows.length,
    1,
    "a refused fetch is audited too: an attempt to hear a destroyed recording is at least as " +
      "interesting as a successful one",
  );
});

test("the teacher's decision closes the loop and is on the register", async () => {
  const ids = await seedReviewable({ label: "decided" });

  const before = await findInStaffQueue(ids.finding);
  assert.ok(before.found, "precondition: the finding must be waiting before it is decided");

  const review = await request(baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: {
      findingId: ids.finding,
      teacherId: "teacher-1",
      decision: "accepted",
      note: "Heard it; the ghunnah is short.",
    },
  });
  assert.equal(review.status, 200, `the decision was refused: ${review.text}`);

  // `/v1/teacher-review-queue` is the register of decisions MADE — not, as its name suggests, the
  // work waiting. (A first version of this test read it as the pending queue and failed; the
  // handler at review.rs:397 selects from `teacher_reviews`.) Newest first, so a decision just made
  // is on the first page or it is nowhere.
  const register = await request(baseUrl, "/v1/teacher-review-queue", { role: "teacher" });
  assert.equal(register.status, 200, `the teacher cannot read the review register: ${register.text}`);
  const rows = Array.isArray(register.body) ? register.body : [];
  const mine = rows.find((r) => r.findingId === ids.finding);
  assert.ok(
    mine,
    `the decision the teacher just made is not on the register — a review nobody can find is a ` +
      `review that did not happen.`,
  );
  assert.equal(mine.teacherId, "teacher-1", "the register must name who decided");
  assert.equal(mine.decision, "accepted");
});

/**
 * N14b — the three WRITE operations on recitation sessions.
 * specs/migration-completion/plan.md §2 · port of handlers/recitation.rs
 *
 *   NODE_API_PORTED="POST /v1/recitation-sessions,POST /v1/recitation-sessions/{id}/alignments,POST /v1/recitation-sessions/{id}/request-teacher-review" \
 *     node --test tests/api-parity/session-writes-parity.test.mjs
 *
 * These carry the policies the reads only display, and three of them are the kind that look like
 * style until you read the history: an FK-check ORDER that is the difference between a fix and an
 * enumeration oracle, a provenance rule that used to return 200 with a substituted label, and a
 * cascade that destroys a teacher's review history on a learner's action.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertABMutating } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

let api;
let shell;
let learnerId;
let modelVersion;

before(async () => {
  api = await startApi({});
  shell = await startShell({ upstream: api.baseUrl });
  const [l] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [m] = await queryJson("SELECT id FROM model_versions ORDER BY id LIMIT 1");
  assert.ok(l && m, "this suite needs a seeded learner and a seeded model version");
  learnerId = l.id;
  modelVersion = m.id;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const sessionBody = (overrides = {}) => ({
  learnerId,
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  sourceChecksum: "sha256:test",
  modelVersion,
  language: "ar",
  consent: {
    recordingConsent: true,
    audioRetention: "discard",
    anonymizedLearning: false,
    externalAsrProcessing: false,
    guardianApproved: false,
    consentVersion: "pilot-v1",
  },
  ...overrides,
});

/** Every id and the audit id are per-call; nothing else may differ. */
const normalizeSession = (b) =>
  b && typeof b === "object" && b.id
    ? { ...b, id: "<ID>", auditEventId: "<AUDIT>" }
    : b;

const createOn = (baseUrl, body) =>
  request(baseUrl, "/v1/recitation-sessions", { method: "POST", role: "learner", userId: learnerId, body });

// ── create_session ─────────────────────────────────────────────────────────────────────────────

test("creating a session returns the same struct, in declaration order", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "create session",
    probeFor: () => ({
      path: "/v1/recitation-sessions",
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: sessionBody(),
    }),
    normalize: normalizeSession,
  });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(Object.keys(s.body), [
    "id",
    "tenantId",
    "learnerId",
    "quranRef",
    "sourceChecksum",
    "modelVersion",
    "language",
    "mode",
    "practicePlanId",
    "externalProcessingAllowed",
    "confidence",
    "reviewStatus",
    "consent",
    "auditEventId",
  ]);
  assert.equal(s.body.mode, "guided-recite", "serde default");
  assert.equal(s.body.practicePlanId, "fatihah-mastery-v1", "serde default");
  assert.equal(s.body.reviewStatus, "draft");
});

test("externalProcessingAllowed needs BOTH consent and guardian approval", async () => {
  for (const [externalAsrProcessing, guardianApproved, expected] of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `consent asr=${externalAsrProcessing} guardian=${guardianApproved}`,
      probeFor: () => ({
        path: "/v1/recitation-sessions",
        method: "POST",
        role: "learner",
        userId: learnerId,
        body: sessionBody({
          consent: { ...sessionBody().consent, externalAsrProcessing, guardianApproved },
        }),
      }),
      normalize: normalizeSession,
    });
    assert.equal(
      s.body.externalProcessingAllowed,
      expected,
      `asr=${externalAsrProcessing} guardian=${guardianApproved} must resolve to ${expected}. ` +
        "Consent to external ASR without guardian approval does not permit it.",
    );
  }
});

test("creating a session WRITES a consent record, not just a snapshot", async () => {
  const res = await createOn(shell.baseUrl, sessionBody());
  assert.equal(res.status, 200, res.text);
  const [row] = await queryJson(
    `SELECT cr.audio_retention, cr.guardian_approved, cr.consent_version
     FROM recitation_sessions s JOIN consent_records cr ON cr.id = s.consent_record_id
     WHERE s.id = $1`,
    [res.body.id],
  );
  assert.ok(row, "a session must be linked to a consent_records row, not only a JSON snapshot");
  assert.equal(row.audio_retention, "discard");
  assert.equal(row.consent_version, "pilot-v1");
});

/**
 * The ordering that is the whole point of FK2.
 *
 * The learner-existence check runs AFTER `require_self_or_any`. Put it first and a learner learns
 * which learner ids exist by reading 404-against-403 — so both answers are compared here, for the
 * same caller, against the two different targets that produce them.
 */
test("an unknown learner is 404 but ONLY for a caller allowed to ask; others get 403", async () => {
  const { shell: asAdmin } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "admin creates for a nonexistent learner",
    probeFor: () => ({
      path: "/v1/recitation-sessions",
      method: "POST",
      role: "admin",
      body: sessionBody({ learnerId: "learner-does-not-exist" }),
    }),
    normalize: normalizeSession,
  });
  assert.equal(asAdmin.status, 404, "an admin may ask, and gets the honest answer");

  const { shell: asLearner } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "learner creates for someone else",
    probeFor: () => ({
      path: "/v1/recitation-sessions",
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: sessionBody({ learnerId: "learner-does-not-exist" }),
    }),
    normalize: normalizeSession,
  });
  assert.equal(
    asLearner.status,
    403,
    "a learner must be refused BEFORE the existence check, or 404-vs-403 enumerates learner ids",
  );
});

test("a teacher may NOT open a session for a learner — only admin/ops", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "teacher creates for a learner",
    probeFor: () => ({
      path: "/v1/recitation-sessions",
      method: "POST",
      role: "teacher",
      body: sessionBody(),
    }),
    normalize: normalizeSession,
  });
  assert.equal(s.status, 403, "the allowlist here is [admin, ops]; teacher is deliberately absent");
});

test("an unknown modelVersion is 400 NAMING it — not the shared 404", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "create with an unknown model version",
    probeFor: () => ({
      path: "/v1/recitation-sessions",
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: sessionBody({ modelVersion: "model-does-not-exist" }),
    }),
    normalize: normalizeSession,
  });
  assert.equal(s.status, 400);
  assert.match(
    s.body.error,
    /model-does-not-exist/,
    "this endpoint can fail on learnerId OR modelVersion; a shared message leaves the caller guessing",
  );
});

test("an unsupported language is 400 naming the allowed set", async () => {
  for (const language of ["klingon", "", "AR", "ar-SA"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `language ${JSON.stringify(language)}`,
      probeFor: () => ({
        path: "/v1/recitation-sessions",
        method: "POST",
        role: "learner",
        userId: learnerId,
        body: sessionBody({ language }),
      }),
      normalize: normalizeSession,
    });
    assert.equal(s.status, 400, `${language} must be refused`);
  }
});

// ── persist_session_alignments ─────────────────────────────────────────────────────────────────

async function freshSession(baseUrl) {
  const res = await createOn(baseUrl, sessionBody());
  assert.equal(res.status, 200, res.text);
  return res.body.id;
}

/** Real canonical word ids, so the FK is satisfied and rows actually persist. */
async function canonicalWordIds(n) {
  const rows = await queryJson(
    "SELECT id FROM canonical_words WHERE ayah_id = '1:1' ORDER BY word_index LIMIT $1",
    [n],
  );
  assert.equal(rows.length, n, `need ${n} canonical word(s) from ayah 1:1, got ${rows.length}`);
  return rows.map((r) => r.id);
}

test("alignments persist, and synthetic word ids are SKIPPED rather than 500", async () => {
  const words = await canonicalWordIds(2);
  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(api.baseUrl);

  const alignments = [
    { wordId: words[0], heardText: "x", startMs: 0, endMs: 100, confidence: 0.9, status: "matched" },
    { wordId: words[1], heardText: "y", startMs: 100, endMs: 200, confidence: 0.5, status: "misread" },
    // "extra-N" is a word the learner said that is not in the canonical text. EXPECTED to be absent
    // from canonical_words — a skip, not an error.
    { wordId: "extra-1", heardText: "z", startMs: 200, endMs: 300, confidence: 0.4, status: "extra" },
    // An unrecognised status is an ML data-quality signal, counted separately from an unknown word.
    { wordId: words[0], heardText: "w", startMs: 300, endMs: 400, confidence: 0.3, status: "matche" },
  ];

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "persist alignments",
    probeFor: (side) => ({
      path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/alignments`,
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: { alignments },
    }),
    normalize: (b) =>
      b && typeof b === "object" ? { ...b, sessionId: "<S>", auditEventId: "<A>" } : b,
  });

  assert.equal(s.status, 200, s.text);
  assert.deepEqual(Object.keys(s.body), [
    "auditEventId",
    "persisted",
    "sessionId",
    "skippedInvalidStatus",
    "skippedUnknownWord",
    "transcriptSource",
  ]);
  assert.equal(s.body.persisted, 2);
  // ADR-0030. This route can only ever mint the weaker label: its words came from the request body.
  // On the wire so a caller is never left assuming they were recorded as measured evidence.
  assert.equal(s.body.transcriptSource, "client-reported");
  assert.equal(s.body.skippedUnknownWord, 1, "extra-1 is not a canonical word");
  assert.equal(s.body.skippedInvalidStatus, 1, '"matche" is a typo, counted separately');
});

test("confidence is clamped to [0,1] before it reaches the numeric column", async () => {
  const words = await canonicalWordIds(2);
  const sessionId = await freshSession(shell.baseUrl);
  const res = await request(shell.baseUrl, `/v1/recitation-sessions/${sessionId}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      alignments: [
        { wordId: words[0], heardText: "a", startMs: 0, endMs: 1, confidence: 99, status: "matched" },
        { wordId: words[1], heardText: "b", startMs: 1, endMs: 2, confidence: -5, status: "matched" },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  const rows = await queryJson(
    "SELECT confidence::float8 AS c FROM word_alignments WHERE session_id = $1 ORDER BY start_ms",
    [sessionId],
  );
  assert.deepEqual(rows.map((r) => Number(r.c)), [1, 0]);
});

/**
 * The provenance rule, and why a 200 was worse than the 500 it replaced.
 *
 * A PRESENT-but-unknown modelVersion used to fall back to "model-v0.3" and return 200. The caller
 * says "this alignment came from model X", the row is stored as model-v0.3, and nothing tells them
 * the label changed — so every downstream "which model produced this?" has a confidently wrong
 * answer. An ABSENT value still defaults, because the caller asserted nothing.
 */
test("modelVersion: absent DEFAULTS, present-and-unknown is REFUSED", async () => {
  const words = await canonicalWordIds(1);
  const align = [
    { wordId: words[0], heardText: "a", startMs: 0, endMs: 1, confidence: 0.5, status: "matched" },
  ];

  const absentSession = await freshSession(shell.baseUrl);
  const absent = await request(shell.baseUrl, `/v1/recitation-sessions/${absentSession}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: { alignments: align },
  });
  assert.equal(absent.status, 200, "an absent modelVersion asserts nothing and may default");
  const [row] = await queryJson(
    "SELECT model_version_id FROM word_alignments WHERE session_id = $1",
    [absentSession],
  );
  assert.equal(row.model_version_id, "model-v0.3");

  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(api.baseUrl);
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "persist with an unknown modelVersion",
    probeFor: (side) => ({
      path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/alignments`,
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: { alignments: align, modelVersion: "model-does-not-exist" },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400, "a stated-but-unknown provenance must be refused, never substituted");
  assert.match(s.body.error, /model-does-not-exist/);
});

test("re-recording REPLACES the prior alignment and AUDITS what it destroyed", async () => {
  const words = await canonicalWordIds(2);
  const sessionId = await freshSession(shell.baseUrl);
  const post = (alignments) =>
    request(shell.baseUrl, `/v1/recitation-sessions/${sessionId}/alignments`, {
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: { alignments },
    });

  await post([
    { wordId: words[0], heardText: "a", startMs: 0, endMs: 1, confidence: 0.5, status: "matched" },
    { wordId: words[1], heardText: "b", startMs: 1, endMs: 2, confidence: 0.5, status: "matched" },
  ]);
  const second = await post([
    { wordId: words[0], heardText: "c", startMs: 0, endMs: 1, confidence: 0.5, status: "matched" },
  ]);
  assert.equal(second.status, 200, second.text);

  const rows = await queryJson(
    "SELECT heard_text FROM word_alignments WHERE session_id = $1",
    [sessionId],
  );
  assert.equal(rows.length, 1, "replace-on-write: the prior alignment must be gone, not appended to");
  assert.equal(rows[0].heard_text, "c");

  // The audit records what this request ACTUALLY destroyed. A learner re-recording their own
  // session can erase a teacher's reviews; whether that cascade is the right POLICY is still open,
  // but the erasure must be VISIBLE.
  const [audit] = await queryJson("SELECT metadata FROM audit_events WHERE id = $1", [
    second.body.auditEventId,
  ]);
  assert.ok(audit, "persisting must leave an audit row");
  assert.equal(typeof audit.metadata.deletedTeacherReviews, "number");
  assert.equal(typeof audit.metadata.deletedTajweedFindings, "number");
  assert.equal(audit.metadata.count, 1);
});

test("alignments on an unknown session are 404, and on someone else's are 403", async () => {
  const { shell: unknown } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "alignments for an unknown session",
    probeFor: () => ({
      path: "/v1/recitation-sessions/no-such-session/alignments",
      method: "POST",
      role: "admin",
      body: { alignments: [] },
    }),
    normalize: (b) => b,
  });
  assert.equal(unknown.status, 404);

  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(api.baseUrl);
  const { shell: notMine } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "alignments for another learner's session",
    probeFor: (side) => ({
      path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/alignments`,
      method: "POST",
      role: "learner",
      userId: "learner-someone-else",
      body: { alignments: [] },
    }),
    normalize: (b) => b,
  });
  assert.equal(notMine.status, 403);
});

// ── request_teacher_review ─────────────────────────────────────────────────────────────────────

test("sending to teacher flips draft -> teacher-review-required, and is idempotent", async () => {
  const sessionId = await freshSession(shell.baseUrl);
  const send = () =>
    request(shell.baseUrl, `/v1/recitation-sessions/${sessionId}/request-teacher-review`, {
      method: "POST",
      role: "learner",
      userId: learnerId,
    });

  const first = await send();
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(Object.keys(first.body), ["auditEventId", "reviewStatus", "sessionId"]);
  assert.equal(first.body.reviewStatus, "teacher-review-required");

  // The observable effect, not the 200: the row must actually move, or the button is the same lie
  // it was before this endpoint existed.
  const [row] = await queryJson("SELECT review_status FROM recitation_sessions WHERE id = $1", [
    sessionId,
  ]);
  assert.equal(row.review_status, "teacher-review-required");

  const second = await send();
  assert.equal(second.status, 200, "a double-tap must never error");
  assert.deepEqual(Object.keys(second.body), ["alreadyRequested", "reviewStatus", "sessionId"]);
  assert.equal(second.body.alreadyRequested, true);
  assert.equal(second.body.auditEventId, undefined, "nothing happened, so no audit row is written");
});

test("only the OWNER may send — there is no staff override", async () => {
  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(api.baseUrl);
  for (const role of ["teacher", "admin", "ops", "scholar"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `send as ${role}`,
      probeFor: (side) => ({
        path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/request-teacher-review`,
        method: "POST",
        role,
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 403, `${role} must not send a learner's session on their behalf`);
  }
});

test("a session past draft is 400, not silently reset", async () => {
  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(api.baseUrl);
  for (const id of [shellSession, rustSession]) {
    await queryJson("UPDATE recitation_sessions SET review_status = 'scholar-approved' WHERE id = $1", [id]);
  }

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "send an already-approved session",
    probeFor: (side) => ({
      path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/request-teacher-review`,
      method: "POST",
      role: "learner",
      userId: learnerId,
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400);
  assert.match(
    s.body.error,
    /scholar-approved/,
    "a session a scholar has progressed must not be reset by a learner action",
  );
});

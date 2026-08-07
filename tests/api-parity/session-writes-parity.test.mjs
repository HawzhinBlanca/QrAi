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

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "POST /v1/recitation-sessions,POST /v1/recitation-sessions/{id}/alignments,POST /v1/recitation-sessions/{id}/request-teacher-review";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;
let learnerId;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED } });
  const [l] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  assert.ok(l, "this suite needs a seeded learner");
  learnerId = l.id;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const sessionBody = (overrides = {}) => ({
  learnerId,
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  sourceChecksum: "sha256:test",
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const { shell: asAdmin } = await assertABMutating(shell.baseUrl, rustUrl, {
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

  const { shell: asLearner } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

test("a caller-supplied session model identity is refused", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  assert.match(s.body.error, /server-selected.*must not be supplied/);
});

test("an unsupported language is 400 naming the allowed set", async () => {
  for (const language of ["klingon", "", "AR", "ar-SA"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

// integration.rs:6310 — a_client_posted_alignment_is_recorded_as_client_reported

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
  const rustSession = await freshSession(rustUrl);

  const alignments = [
    { wordId: words[0], heardText: "x", startMs: 0, endMs: 100, confidence: 0.9, status: "matched" },
    { wordId: words[1], heardText: "y", startMs: 100, endMs: 200, confidence: 0.5, status: "misread" },
    // "extra-N" is a word the learner said that is not in the canonical text. EXPECTED to be absent
    // from canonical_words — a skip, not an error.
    { wordId: "extra-1", heardText: "z", startMs: 200, endMs: 300, confidence: 0.4, status: "extra" },
    // An unrecognised status is an ML data-quality signal, counted separately from an unknown word.
    { wordId: words[0], heardText: "w", startMs: 300, endMs: 400, confidence: 0.3, status: "matche" },
  ];

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    "skippedUnusableSpan",
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
 * Alignment identity is selected once by the server at session creation. Every alignment write
 * inherits that stored value; no request can replace it and no independent fallback can drift.
 */
test("alignment writes inherit the session model and refuse every supplied identity", async () => {
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
  assert.equal(absent.status, 200, "the server-selected session model is sufficient");
  const [sessionModel] = await queryJson(
    "SELECT model_version_id FROM recitation_sessions WHERE id = $1",
    [absentSession],
  );
  const [row] = await queryJson(
    "SELECT model_version_id FROM word_alignments WHERE session_id = $1",
    [absentSession],
  );
  assert.equal(row.model_version_id, sessionModel.model_version_id);

  const shellSession = await freshSession(shell.baseUrl);
  const rustSession = await freshSession(rustUrl);
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "persist with a caller modelVersion",
    probeFor: (side) => ({
      path: `/v1/recitation-sessions/${side === "shell" ? shellSession : rustSession}/alignments`,
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: { alignments: align, modelVersion: sessionModel.model_version_id },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400, "even the current server model must not be caller-selected");
  assert.match(s.body.error, /server-selected.*must not be supplied/);
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
  const { shell: unknown } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const rustSession = await freshSession(rustUrl);
  const { shell: notMine } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const rustSession = await freshSession(rustUrl);
  for (const role of ["teacher", "admin", "ops", "scholar"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const rustSession = await freshSession(rustUrl);
  for (const id of [shellSession, rustSession]) {
    await queryJson("UPDATE recitation_sessions SET review_status = 'scholar-approved' WHERE id = $1", [id]);
  }

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

// ── The evidence a finding points at must exist ───────────────────────────────────────────────────
//
// A tajweed finding is anchored to a `word_alignments` row, and that row's `start_ms`/`end_ms` are
// the only thing saying WHERE in the recitation it happened. A reviewer asked to adjudicate a
// finding — the whole point of the review queue, and the precondition for ever building an
// adjudicated corpus — needs to hear that span.
//
// Both servers invented one instead of refusing. Rust read the field with
// `.and_then(|v| v.as_i64()).unwrap_or(0)` (recitation.rs) and the port with
// `Number.isInteger(a.startMs) ? a.startMs : 0` (session-writes.mjs): a missing, null, string or
// float timing became the integer 0. A payload carrying no timings at all was stored as a row
// spanning 0ms to 0ms — a finding pointing at nothing, indistinguishable in the table from one
// pointing at real audio.
//
// Measured in staging before the fix: 2686 tajweed findings, of which 507 (19%) resolved to a
// zero-length span, and 224 alignments overall. Nothing had ever reported it because a 0 is a
// perfectly valid integer and every layer accepted it.
//
// The web client already refuses to produce one — `liveRecitation.ts:288` computes
// `endMs = Math.max(startMs + 1, ...)` deliberately. That guard was in the client, which is a
// display choice, not an authority. The same argument as ADR-0028: the server has to be the one
// that says no.
const UNUSABLE_SPANS = [
  ["no timings at all", {}],
  ["null timings", { startMs: null, endMs: null }],
  ["zero-length", { startMs: 500, endMs: 500 }],
  ["inverted", { startMs: 900, endMs: 400 }],
  ["negative start", { startMs: -1, endMs: 100 }],
  ["non-integer startMs", { startMs: "abc", endMs: 100 }],
  ["fractional startMs", { startMs: 1.5, endMs: 100 }],
];

test("an alignment with no usable time span is never stored", async () => {
  const words = await canonicalWordIds(1);
  // Every case probed and reported together. Failing on the first would hide how many of the seven
  // are wrong and on which implementation — and that spread is the finding.
  const wrong = [];

  for (const [label, span] of UNUSABLE_SPANS) {
    const seen = {};
    for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
      const sessionId = await freshSession(base);
      const res = await request(base, `/v1/recitation-sessions/${sessionId}/alignments`, {
        method: "POST",
        role: "learner",
        userId: learnerId,
        body: {
          alignments: [
            { wordId: words[0], heardText: "x", confidence: 0.9, status: "matched", ...span },
          ],
        },
      });
      const [{ n }] = await queryJson(
        "SELECT count(*)::int AS n FROM word_alignments WHERE session_id = $1",
        [sessionId],
      );
      seen[impl] = res.status;

      // THE invariant, asserted absolutely against each implementation rather than by comparing
      // them: no row, therefore no finding can ever be anchored to a span that identifies no audio.
      if (n !== 0) wrong.push(`${impl} "${label}" stored ${n} row(s) — status ${res.status}`);
      // And it must be reported, not silently dropped: a client sending unusable timings has to be
      // able to learn that, or it discovers months later that its findings point nowhere.
      if (res.status === 200 && res.body?.skippedUnusableSpan !== 1) {
        wrong.push(
          `${impl} "${label}" was accepted but skippedUnusableSpan=${res.body?.skippedUnusableSpan}`,
        );
      }
    }
    // Wire parity on the same input. Before the fix these disagreed: Rust answered 422 for a null,
    // string or fractional timing while the port accepted all three and wrote a 0-to-0 row.
    if (seen.shell !== seen.rust) {
      wrong.push(`"${label}" DIVERGES — shell ${seen.shell} vs rust ${seen.rust}`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `an alignment carrying no usable time span reached the table. A finding anchored to it points at
no audio, and nothing downstream can tell that from a finding pointing at real audio:
  ${wrong.join("\n  ")}`,
  );
});

test("a VALID span is still stored, verbatim — the control", async () => {
  // Without this, every assertion above is satisfied by a handler that refuses ALL alignments,
  // which would silently end recitation capture entirely.
  const words = await canonicalWordIds(2);

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    const sessionId = await freshSession(base);
    const res = await request(base, `/v1/recitation-sessions/${sessionId}/alignments`, {
      method: "POST",
      role: "learner",
      userId: learnerId,
      body: {
        alignments: [
          { wordId: words[0], heardText: "x", startMs: 0, endMs: 100, confidence: 0.9, status: "matched" },
          { wordId: words[1], heardText: "y", startMs: 640, endMs: 1230, confidence: 0.5, status: "misread" },
        ],
      },
    });
    assert.equal(res.status, 200, `${impl}: a valid payload was refused — ${res.text}`);

    const rows = await queryJson(
      "SELECT start_ms, end_ms FROM word_alignments WHERE session_id = $1 ORDER BY start_ms",
      [sessionId],
    );
    assert.deepEqual(
      rows.map((r) => [Number(r.start_ms), Number(r.end_ms)]),
      [[0, 100], [640, 1230]],
      `${impl}: the stored span is not the span that was sent`,
    );
  }
});

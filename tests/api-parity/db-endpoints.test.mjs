import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertMatchesContract } from "./lib/contract.mjs";
import { queryJson, request, startApi } from "./lib/harness.mjs";

/**
 * C1 — the five database-backed pairs that had NEITHER a fixture nor a parity test.
 * specs/contract-coverage-closure/plan.md §5
 *
 * Every one of these asserts the AUTHORIZATION boundary, not just reachability. A coverage test that
 * only proves a 200 is how POST /v1/teacher-reviews came to be counted as an endpoint with no
 * assertion behind it in the first place — the route existed, the router registered it, and nothing
 * black-box had ever checked who was allowed to call it.
 */

let api;
before(async () => {
  api = await startApi();
});
after(async () => {
  await api?.stop();
});

// ── GET /v1/quran/surahs/{surah_number} ────────────────────────────────────────────────────────

test("GET /v1/quran/surahs/{n} serves canonical text WITHOUT authentication", async () => {
  // quran.rs:80 takes `_headers` and never resolves an actor. That is deliberate — the Quranic text
  // is not tenant data and not gated — so the test states it rather than leaving a reader to infer
  // it from an absence. If this ever starts requiring auth, that is a product decision and this
  // assertion should be what forces the conversation.
  const res = await request(api.baseUrl, "/v1/quran/surahs/1", { tenant: null });
  assert.equal(res.status, 200);
  assertMatchesContract("GET", "/v1/quran/surahs/1", res);
  assert.equal(res.body.surahNumber, 1);
  assert.equal(res.body.ayahs.length, 7, "Al-Fatihah has 7 ayahs");

  const [first] = res.body.ayahs;
  assert.deepEqual(Object.keys(first).sort(), [
    "ayahNumber",
    "id",
    "sourceChecksum",
    "surahNumber",
    "text",
  ]);
  assert.equal(first.ayahNumber, 1);
  assert.match(first.text, /[؀-ۿ]/, "text_uthmani must be Arabic");
  assert.ok(first.sourceChecksum.length > 0, "checksum is the provenance of scripture — never empty");
});

test("GET /v1/quran/surahs/{n} is 404 for a surah that does not exist", async () => {
  const res = await request(api.baseUrl, "/v1/quran/surahs/115", { tenant: null });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "record not found");
});

// ── GET /v1/eval-runs/{model_version} ──────────────────────────────────────────────────────────

test("GET /v1/eval-runs/{v} returns the seeded run to admin, and is shaped as EvalRun", async () => {
  const [seeded] = await queryJson(
    "SELECT model_version_id FROM eval_runs ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(seeded, "0006_seed_internal.sql must have seeded an eval run");

  const res = await request(api.baseUrl, `/v1/eval-runs/${seeded.model_version_id}`, { role: "admin" });
  assert.equal(res.status, 200);
  assertMatchesContract("GET", `/v1/eval-runs/${seeded.model_version_id}`, res);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "datasetVersion",
    "falsePositiveRate",
    "modelVersion",
    "passed",
    "tajweedF1",
    "teacherAgreementRate",
    "unsourcedLearnerOutputs",
    "wordAlignmentF1",
  ]);
  assert.equal(res.body.modelVersion, seeded.model_version_id);
  assert.equal(typeof res.body.passed, "boolean");
  // A release gate that reads a metric as a string would compare it as one. Pin the types.
  for (const key of ["wordAlignmentF1", "tajweedF1", "falsePositiveRate", "teacherAgreementRate"]) {
    assert.equal(typeof res.body[key], "number", `${key} must be a number, not a string`);
  }
});

test("GET /v1/eval-runs/{v} is 403 for a learner — model quality is staff-only", async () => {
  const res = await request(api.baseUrl, "/v1/eval-runs/anything", { role: "learner" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "actor is not allowed to perform this action");
});

test("GET /v1/eval-runs/{v} is 404 for an unknown model version", async () => {
  const res = await request(api.baseUrl, "/v1/eval-runs/model-that-does-not-exist", { role: "ops" });
  assert.equal(res.status, 404);
});

// ── GET /v1/audit-events ───────────────────────────────────────────────────────────────────────

test("GET /v1/audit-events returns tenant-scoped events to ops", async () => {
  const res = await request(api.baseUrl, "/v1/audit-events", { role: "ops" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assertMatchesContract("GET", "/v1/audit-events", res);

  // Asserted on SHAPE, not on a count: every other suite in this repo writes audit rows, so a
  // length assertion here would be flaky by construction and would get muted rather than fixed.
  for (const event of res.body) {
    assert.deepEqual(Object.keys(event).sort(), [
      "action",
      "actorId",
      "id",
      "subjectId",
      "subjectType",
      "tenantId",
      "traceId",
    ]);
  }
});

test("GET /v1/audit-events is 403 for a learner AND for a teacher", async () => {
  // audit.rs:15 allows Admin and Ops only. Teacher is the interesting case: it is staff, so a
  // reader could reasonably assume it is allowed. The audit log names who did what to whom, and
  // narrowing it to admin/ops is a deliberate choice worth pinning.
  for (const role of ["learner", "teacher"]) {
    const res = await request(api.baseUrl, "/v1/audit-events", { role });
    assert.equal(res.status, 403, `${role} must not read the audit log`);
  }
});

// ── POST /v1/teacher-reviews ───────────────────────────────────────────────────────────────────

/**
 * `TeacherReviewRequest` (types.rs:229) has FOUR required fields — `findingId`, `teacherId`,
 * `decision`, `note`. None is `Option`, so a body missing any of them is rejected by the extractor
 * with a 422 before the handler runs.
 *
 * `teacherId` is required and then **discarded**: review.rs binds the author to the actor. So the
 * wire contract obliges a caller to send a value the server ignores. Recorded here because a test
 * that quietly omitted it would have "passed" against a redesigned request type.
 */
const reviewBody = (overrides) => ({
  findingId: "placeholder",
  teacherId: "teacher-1",
  decision: "accepted",
  note: "parity coverage",
  ...overrides,
});

test("POST /v1/teacher-reviews records a review against a real finding", async () => {
  const [finding] = await queryJson("SELECT id FROM tajweed_findings ORDER BY id LIMIT 1");
  assert.ok(finding, "0006_seed_internal.sql must have seeded a tajweed finding");

  const res = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: finding.id }),
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/teacher-reviews", res);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "auditEventId",
    "decision",
    "findingId",
    "id",
    "note",
    "teacherId",
    "tenantId",
  ]);
  assert.equal(res.body.findingId, finding.id);
  assert.equal(res.body.decision, "accepted");
  assert.ok(res.body.auditEventId, "a review is an accountable act — it must carry its audit row");
});

test("POST /v1/teacher-reviews cannot forge authorship by supplying another teacherId", async () => {
  // review.rs binds the author to the ACTOR, never to the caller-supplied field — the authorship
  // forgery fixed in 1675d62. Sending admin-1 while acting as teacher-1 must not be honoured.
  const [finding] = await queryJson("SELECT id FROM tajweed_findings ORDER BY id LIMIT 1");
  const res = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: finding.id, decision: "rejected", teacherId: "admin-1" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.teacherId, "teacher-1", "a supplied teacherId must be ignored, not honoured");
});

test("POST /v1/teacher-reviews is 404 for a dangling finding, not a 500", async () => {
  // A missing referenced entity is a 404. Before the pre-check this hit the FK constraint and
  // surfaced as a 500, which is a different thing to a caller and to an alerting rule.
  const res = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: "finding-does-not-exist" }),
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "record not found");
});

test("POST /v1/teacher-reviews is 403 for a learner and for a scholar", async () => {
  // review.rs:16 allows Teacher, Admin, Ops. Scholar is excluded — scholars sign scholar-approvals,
  // a separate artifact — and that boundary is easy to erode without a test on it.
  //
  // The body is WELL-FORMED on purpose: the Json extractor runs before the handler, so a malformed
  // body would 422 and this test would pass without the authorization check ever being reached.
  for (const role of ["learner", "scholar"]) {
    const res = await request(api.baseUrl, "/v1/teacher-reviews", {
      method: "POST",
      role,
      body: reviewBody({ findingId: "irrelevant" }),
    });
    assert.equal(res.status, 403, `${role} must not submit a teacher review`);
  }
});

// ── POST /v1/privacy/{export,delete} — a missing learner is 404, not 500 ───────────────────────

/**
 * PJ2 — specs/privacy-job-404/plan.md §5.
 *
 * integration.rs:1424 — privacy_job_for_unknown_learner_is_not_found
 * integration.rs:1457 — privacy_job_answers_forbidden_before_not_found
 *
 * These were written and run RED against the unfixed binary first:
 *
 *   not ok - privacy export/delete is 404 for a learner that does not exist
 *     500 !== 404
 *
 * A test written after the fix, never seen failing, only proves the fix is present — not that it
 * addresses the defect.
 */
for (const route of ["/v1/privacy/export", "/v1/privacy/delete"]) {
  test(`POST ${route} is 404 for a learner that does not exist, not 500`, async () => {
    // privacy_jobs.learner_id REFERENCES users(id). Without a pre-check the insert violates the FK
    // and surfaces as "a database error occurred" — indistinguishable from a real database failure
    // on a right-to-erasure endpoint, and it invites a retry that can never succeed.
    const res = await request(api.baseUrl, route, {
      method: "POST",
      role: "admin",
      body: { learnerId: `learner-does-not-exist-${Math.random().toString(36).slice(2, 10)}` },
    });
    assert.equal(res.status, 404, `expected a clean 404, got ${res.status} ${res.text}`);
    assert.equal(res.body.error, "record not found");
  });

  test(`POST ${route} answers 403 BEFORE 404 for another learner`, async () => {
    // Ordering, pinned. If the existence check ever moved ahead of require_self_or_any, a learner
    // could probe which learner ids exist by reading 404-vs-403 — the check added to fix a 500
    // would have created an enumeration oracle.
    const res = await request(api.baseUrl, route, {
      method: "POST",
      role: "learner",
      body: { learnerId: "learner-2" },
    });
    assert.equal(res.status, 403, "authorization must be decided before existence");
  });
}

// ── FK surface: a dangling reference is never a 500 ────────────────────────────────────────────

/**
 * FK4 — specs/fk-surface-sweep/plan.md §7.
 *
 * integration.rs:1424 — privacy_job_for_unknown_learner_is_not_found
 *
 * The same defect has been found and fixed three times now — teacher-reviews, privacy-jobs, and
 * these — each time by accident while doing something else. This block exists so there is no fourth
 * accident: it covers the endpoints that were WRONG *and* the ones that were already right, because
 * nothing was stopping the correct ones from regressing into 500s.
 *
 * Run red against the unfixed binary first.
 */
const ghostId = () => `ghost-${Math.random().toString(36).slice(2, 10)}`;

const sessionBody = (overrides) => ({
  learnerId: "learner-1",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
  sourceChecksum: "parity-checksum",
  modelVersion: "model-v0.3",
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

const agentRunBody = (overrides) => ({
  name: "fk-sweep",
  goal: "coverage",
  status: "queued",
  confidence: 0.5,
  reviewStatus: "draft",
  sources: [],
  ...overrides,
});

test("POST /v1/agent-runs is 404 for a learnerId that does not exist", async () => {
  const res = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: agentRunBody({ learnerId: ghostId() }),
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status} ${res.text}`);
  assert.equal(res.body.error, "record not found");
});

test("POST /v1/agent-runs still accepts a run with NO learnerId", async () => {
  // learner_id is Option — the mistake-pattern and practice-plan agents both write runs without
  // one. If the new check fires on absent-vs-unknown, it breaks the agents service silently.
  const res = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: agentRunBody({}),
  });
  assert.equal(res.status, 200, `a learner-less agent run must still be accepted: ${res.text}`);
});

test("POST /v1/recitation-sessions is 404 for a learnerId that does not exist", async () => {
  const res = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "admin",
    body: sessionBody({ learnerId: ghostId() }),
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status} ${res.text}`);
});

test("POST /v1/recitation-sessions answers 403 BEFORE 404 for another learner", async () => {
  // Second endpoint where this ordering decides between a fix and a vulnerability. If the existence
  // check moved ahead of require_self_or_any, a learner could enumerate learner ids by reading
  // 404-vs-403 on the product's most-called write.
  for (const learnerId of ["learner-2", ghostId()]) {
    const res = await request(api.baseUrl, "/v1/recitation-sessions", {
      method: "POST",
      role: "learner",
      body: sessionBody({ learnerId }),
    });
    assert.equal(res.status, 403, "authorization must be decided before existence");
  }
});

test("POST /v1/recitation-sessions is 400 NAMING an unknown modelVersion", async () => {
  // 400 rather than 404, because modelVersion is a value from a fixed server-side vocabulary —
  // like the agent-run status enum, which already 400s naming the value. It also disambiguates:
  // this endpoint can fail on learnerId OR modelVersion, and the shared "record not found" string
  // cannot say which, leaving a caller guessing between two very different fixes.
  const unknown = ghostId();
  const res = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: sessionBody({ modelVersion: unknown }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.text}`);
  assert.match(res.body.error, new RegExp(unknown), "the error must name the value that was rejected");
});

test("the endpoints that were ALREADY correct stay correct", async () => {
  // These were right by accident of who wrote them, not by any assertion. Pinned so the next sweep
  // does not have to rediscover them.
  const checks = [
    ["/v1/pilot/invitations", "admin", { learnerId: ghostId() }, 404],
    ["/v1/realtime-session-tickets", "learner", { sessionId: ghostId() }, 404],
    [`/v1/recitation-sessions/${ghostId()}/request-teacher-review`, "learner", {}, 404],
    [`/v1/recitation-sessions/${ghostId()}/alignments`, "learner", { alignments: [] }, 404],
  ];
  for (const [path, role, body, expected] of checks) {
    const res = await request(api.baseUrl, path, { method: "POST", role, body });
    assert.equal(res.status, expected, `${path} must stay ${expected}, got ${res.status}`);
  }
});

test("alignments store the model version AS GIVEN, and refuse an unknown one", async () => {
  // THE assertion for FK3, and it reads the row back rather than trusting the 200.
  //
  // The bug being fixed produced a perfectly good response: an unknown model was silently stored as
  // "model-v0.3" and the caller was told it worked. A test that only checked the status code would
  // have passed against the bug, and would pass again if the fallback ever came back.
  const [session] = await queryJson(
    `SELECT id FROM recitation_sessions
     WHERE learner_id = 'learner-1' AND tenant_id = $1
     ORDER BY started_at DESC LIMIT 1`,
    ["hikmah-pilot-erbil"],
  );
  assert.ok(session, "a session owned by learner-1 is required");
  const path = `/v1/recitation-sessions/${session.id}/alignments`;
  const alignment = {
    wordId: "1:1:1",
    status: "matched",
    confidence: 0.9,
    startMs: 0,
    endMs: 100,
    heardText: "a",
    canonicalText: "b",
  };

  // A valid NON-DEFAULT model. If the fallback returns, this stores "model-v0.3" and the mismatch
  // is visible in the database even though the response looks identical.
  const stored = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: { alignments: [alignment], modelVersion: "tajweed-v0.1" },
  });
  assert.equal(stored.status, 200);
  const rows = await queryJson(
    "SELECT DISTINCT model_version_id FROM word_alignments WHERE session_id = $1",
    [session.id],
  );
  assert.deepEqual(
    rows.map((r) => r.model_version_id),
    ["tajweed-v0.1"],
    "the alignment must record the model the caller named — silently relabelling it is provenance falsification",
  );

  // An unknown model is now refused rather than relabelled.
  const unknown = ghostId();
  const rejected = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: { alignments: [alignment], modelVersion: unknown },
  });
  assert.equal(rejected.status, 400, `expected 400, got ${rejected.status} ${rejected.text}`);
  assert.match(rejected.body.error, new RegExp(unknown));

  // An ABSENT model still defaults — that is a default, not a substitution, because the caller
  // asserted nothing. Breaking this would break every client that omits the field.
  const defaulted = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: { alignments: [alignment] },
  });
  assert.equal(defaulted.status, 200, "an absent modelVersion must still default, not 400");
});

test("POST /v1/scholar-approvals binds reviewerId to the ACTOR, so it cannot dangle", async () => {
  const res = await request(api.baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: {
      topic: "fk sweep",
      reviewerId: ghostId(),
      status: "scholar-approved",
      risk: "low",
      sources: [{ id: "s", title: "t", citation: "c", url: null }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.reviewerId, "scholar-1", "a supplied reviewerId must be ignored, not stored");
});

// ── POST /v1/pilot/session/logout ──────────────────────────────────────────────────────────────

test("POST /v1/pilot/session/logout is idempotent with no cookie, and clears the cookie", async () => {
  // Covers the no-cookie path ONLY. pilot.rs:150 skips the revocation block entirely without a
  // __Host-qrai-pilot cookie, so this exercises the whole handler minus the branch that needs a
  // live session. Nothing here mints one, and the login UI stays disabled.
  const res = await request(api.baseUrl, "/v1/pilot/session/logout", {
    method: "POST",
    tenant: null,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "logged_out" });
  assertMatchesContract("POST", "/v1/pilot/session/logout", res);

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "logout must always clear the cookie, even when there was none");
  assert.match(setCookie, /^__Host-qrai-pilot=;/);
  assert.match(setCookie, /Max-Age=0/);
  // The __Host- prefix is only honoured by a browser when all three hold. A clearing cookie that
  // drops them is refused by the browser, and the session cookie survives the logout.
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.ok(setCookie.includes(attribute), `clearing cookie must keep ${attribute}`);
  }
});

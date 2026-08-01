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

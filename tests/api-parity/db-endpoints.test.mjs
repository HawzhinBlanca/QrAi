import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { assertMatchesContract } from "./lib/contract.mjs";
import {
  RLS_PROBE_ROLE,
  TENANT,
  insertDeclaredTestAcousticFinding,
  purgeSessionsByChecksum,
  queryJson,
  request,
  startApi,
  uniqueSuffix,
  withDb,
} from "./lib/harness.mjs";

// Run-scoped so the teardown at the end of this file removes exactly this run's rows. The fixed
// `fnv1a32:p32parity` had accumulated 585 sessions in the shared staging database; see
// purgeSessionsByChecksum in ./lib/harness.mjs for why an unbounded corpus is a correctness problem
// and not merely untidiness.
const RUN_CK_P32 = `fnv1a32:p32parity-${uniqueSuffix()}`;

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
let reviewFixtures;
const SESSION_FINDINGS_PORTED = "GET /v1/recitation-sessions/{id}/tajweed-findings";
before(async () => {
  // Rust ignores this variable on the direct oracle leg. When PARITY_THROUGH_SHELL=1, the Node
  // shell must serve this route locally; a missing PORTABLE/ROUTES entry is therefore a hard boot
  // failure instead of a false-green proxy pass.
  api = await startApi({ env: { NODE_API_PORTED: SESSION_FINDINGS_PORTED } });
  reviewFixtures = await seedAcousticReviewFixtures();
});
after(async () => {
  try {
    await cleanupAcousticReviewFixtures(reviewFixtures);
  } finally {
    await api?.stop();
  }
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
    "calibratorArtifactSha256",
    "calibratorId",
    "candidateId",
    "datasetManifestSha256",
    "datasetVersion",
    "evaluationCounts",
    "evaluationTask",
    "evaluatorProtocolSha256",
    "evaluatorSourceSha256",
    "evaluatorVersion",
    "evidenceEligibility",
    "evidenceId",
    "evidenceKind",
    "evidencePayload",
    "evidencePayloadSha256",
    "falsePositiveRate",
    "modelArtifactSha256",
    "modelVersion",
    "passed",
    "rawResultsSha256",
    "rawRowManifestSha256",
    "releaseEligible",
    "signatureAlgorithm",
    "signatureBase64Url",
    "signedAt",
    "signerKeyId",
    "sliceMetrics",
    "splitId",
    "splitManifestSha256",
    "tajweedF1",
    "teacherAgreementRate",
    "unsourcedLearnerOutputs",
    "wordAlignmentF1",
  ]);
  assert.equal(res.body.modelVersion, seeded.model_version_id);
  assert.equal(typeof res.body.passed, "boolean");
  assert.equal(res.body.evidenceKind, "legacy-aggregate");
  assert.equal(res.body.evidenceEligibility, "fixture-regression");
  assert.equal(res.body.releaseEligible, false);
  for (const key of [
    "evaluationTask",
    "evidenceId",
    "evidencePayload",
    "evidencePayloadSha256",
    "candidateId",
    "modelArtifactSha256",
    "datasetManifestSha256",
    "splitManifestSha256",
    "splitId",
    "evaluatorVersion",
    "evaluatorSourceSha256",
    "evaluatorProtocolSha256",
    "rawRowManifestSha256",
    "rawResultsSha256",
    "calibratorId",
    "calibratorArtifactSha256",
    "signerKeyId",
    "signatureAlgorithm",
    "signatureBase64Url",
    "signedAt",
    "evaluationCounts",
    "sliceMetrics",
  ]) {
    assert.equal(res.body[key], null, `${key} must remain explicit and null for historical rows`);
  }
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

// ── POST /v1/recitation-sessions/{id}/finalize ─────────────────────────────────────────────────

/**
 * ADR-0027 item 5 — a gateway-streamed recitation becomes a reviewable one.
 *
 * integration.rs:4541 — finalize_persists_a_server_derived_alignment_and_refuses_without_consent
 * integration.rs:4609 — finalize_without_a_transcript_stores_nothing
 *
 * Black-box, so it covers whichever implementation is under test. The boundary is OWNERSHIP: this
 * writes what a person is recorded as having recited, and a role-only check would let any learner
 * in the tenant finalize any other learner's session.
 *
 * The happy path needs a live ML service and is covered by the Rust integration tests above with a
 * mock; what runs here is the authorization boundary, which needs neither.
 */
test("POST finalize: another learner is Forbidden", async () => {
  const [session] = await queryJson(
    "SELECT id FROM recitation_sessions WHERE learner_id = 'learner-1' ORDER BY id LIMIT 1",
  );
  assert.ok(session, "the seed must provide a learner-1 session");

  const res = await request(api.baseUrl, `/v1/recitation-sessions/${session.id}/finalize`, {
    method: "POST",
    role: "learner",
    userId: "learner-2",
    body: {},
  });
  assert.equal(res.status, 403, "a learner must not finalize another learner's recitation");
});

test("POST finalize: an unknown session is 404, before the ownership check", async () => {
  const res = await request(api.baseUrl, "/v1/recitation-sessions/session-nope/finalize", {
    method: "POST",
    role: "learner",
    body: {},
  });
  assert.equal(res.status, 404);
});

// ── GET /v1/recitation-sessions/{id}/tajweed-findings ──────────────────────────────────────────

/**
 * ADR-0027 action item 4 — the learner's own findings.
 *
 * integration.rs:4270 — tajweed_findings_persist_and_the_learner_can_read_their_own
 *
 * The boundary is OWNERSHIP, not role: `require_self_or_any(learner_id, [Teacher, Admin, Ops])`.
 * This is the first learner-facing route that reads another person's recitation analysis, so the
 * refusal matters more than the happy path — a role-only check would let any learner in the tenant
 * read any other learner's mistakes.
 */
test("GET session tajweed-findings: a learner reads their OWN session", async () => {
  const session = await reviewFixtureSession();
  assert.equal(session.learner_id, "learner-1", "the declared fixture must belong to learner-1");
  const path = `/v1/recitation-sessions/${session.id}/tajweed-findings`;

  if (api.upstreamUrl) {
    await assertAB(api.baseUrl, api.upstreamUrl, { path, role: "learner" });
  }

  const res = await request(api.baseUrl, path, { role: "learner" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), "an array, even when empty");
  // Withheld findings come back WITH their reviewStatus: the client needs them to distinguish
  // "3 notes are waiting for a teacher" from "no feedback". Filtering here would collapse the two.
  // Their CONTENT does not come back — see the redaction test below.
  for (const f of res.body) {
    assert.ok(typeof f.reviewStatus === "string" && f.reviewStatus.length > 0);
    assert.ok(Array.isArray(f.sources), "provenance must survive the round trip");
    assert.equal(typeof f.withheld, "boolean", "every finding states whether it is learner-visible");
  }
});

/**
 * P3.2 — the learner gate is enforced on the WIRE, not just in the client.
 *
 * integration.rs:4908 — learner_gets_withheld_findings_redacted_and_staff_get_them_intact
 * integration.rs:5017 — seed_findings_cannot_surface_in_a_real_learners_session
 *
 * Black-box, because that is the whole point of the finding this closes: the Rust test could be
 * satisfied by a handler that returns the judgement and a client that hides it. This asserts what a
 * learner's own HTTP response actually contains. Any finding on this route that has not cleared
 * review must carry no rule, no severity, no explanation and no word — nothing that says anything
 * about how the person recited.
 */
test("GET session tajweed-findings: a withheld finding carries no judgement", async () => {
  const session = await reviewFixtureSession();
  const res = await request(api.baseUrl, `/v1/recitation-sessions/${session.id}/tajweed-findings`, {
    role: "learner",
  });
  assert.equal(res.status, 200);

  const withheld = res.body.filter((f) => f.withheld);
  assert.ok(withheld.length > 0, "the declared acoustic fixture must exercise learner redaction");
  for (const f of withheld) {
    for (const field of ["rule", "severity", "explanation", "wordId"]) {
      assert.equal(f[field], "", `a withheld finding leaked \`${field}\` to the learner`);
    }
    assert.equal(f.confidence, 0, "a withheld finding leaked a confidence score");
    assert.deepEqual(f.sources, [], "a withheld finding leaked its sources");
  }

  // The two gates must agree by construction: a redacted row fails the shared client predicate on
  // its own values, so a client that has never heard of `withheld` still cannot display one.
  for (const f of withheld) {
    const clearsClientGate =
      ["teacher-reviewed", "scholar-approved"].includes(f.reviewStatus) &&
      f.confidence >= 0.82 &&
      f.sources.length > 0;
    assert.equal(clearsClientGate, false, "a redacted finding must fail the client gate too");
  }

  // Fixture data. `0006_seed_internal.sql` plants findings that CLEAR the gate — teacher-reviewed,
  // sourced, 0.84 — so nothing about their content stops them being shown. The only thing that does
  // is that they are anchored to the seed session's alignments. A fresh session must therefore come
  // back empty, not populated with demo notes about a recitation that never happened.
  const fresh = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
      sourceChecksum: RUN_CK_P32,

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
  // 200, not 201 — the difference Phase 5's differ recorded rather than "corrected".
  assert.equal(fresh.status, 200, `creating the probe session failed: ${JSON.stringify(fresh.body)}`);

  const empty = await request(
    api.baseUrl,
    `/v1/recitation-sessions/${fresh.body.id}/tajweed-findings`,
    { role: "learner" },
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, [], "a brand-new session came back with findings it cannot have");
});

test("GET session tajweed-findings: staff receive the withheld row intact", async () => {
  const session = await reviewFixtureSession();
  const path = `/v1/recitation-sessions/${session.id}/tajweed-findings`;

  if (api.upstreamUrl) {
    await assertAB(api.baseUrl, api.upstreamUrl, { path, role: "teacher" });
  }

  const res = await request(api.baseUrl, path, { role: "teacher" });
  assert.equal(res.status, 200);
  assertMatchesContract("GET", path, res);

  const finding = res.body.find((row) => row.id === reviewFixtures.sourcedFinding);
  assert.ok(finding, "the declared fixture must be returned to in-tenant staff");
  assert.equal(finding.withheld, true, "staff see whether the row remains learner-withheld");
  assert.equal(finding.wordId.length > 0, true, "staff retain the anchored word judgement");
  assert.equal(finding.rule, "declared-fixture-rule");
  assert.equal(finding.severity, "practice");
  assert.equal(finding.confidence, 0.9);
  assert.equal(finding.explanation, "Declared acoustic fixture for the teacher-review contract");
  assert.equal(finding.sources.length, 1);
});

test("GET session tajweed-findings: scholar is not a learner-performance staff role", async () => {
  const session = await reviewFixtureSession();
  const res = await request(api.baseUrl, `/v1/recitation-sessions/${session.id}/tajweed-findings`, {
    role: "scholar",
  });
  assert.equal(res.status, 403);
});

test("GET session tajweed-findings: another learner is Forbidden", async () => {
  const [session] = await queryJson(
    "SELECT id FROM recitation_sessions WHERE learner_id = 'learner-1' ORDER BY id LIMIT 1",
  );
  const res = await request(api.baseUrl, `/v1/recitation-sessions/${session.id}/tajweed-findings`, {
    role: "learner",
    userId: "learner-2",
  });
  assert.equal(res.status, 403, "a learner must not read another learner's recitation analysis");
});

test("GET session tajweed-findings: an unknown session is 404, not an empty array", async () => {
  // 404 BEFORE the ownership check, so this cannot be used to probe for session ids in another
  // tenant — and an empty array would be indistinguishable from "you have no findings".
  const res = await request(api.baseUrl, "/v1/recitation-sessions/session-nope/tajweed-findings", {
    role: "learner",
  });
  assert.equal(res.status, 404);
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

/**
 * The historical internal seed was assigned the old `canonical-text` default by migration 0025
 * and is therefore deliberately `text-rule` after migration 0030. Review tests must not turn that
 * instruction back into evidence about a learner. These two explicitly declared acoustic fixtures
 * exercise the performance workflow without depending on residue from another test file.
 */
async function seedAcousticReviewFixtures() {
  const suffix = uniqueSuffix();
  const ids = {
    sourcedAudit: `audit-db-endpoints-sourced-${suffix}`,
    unsourcedAudit: `audit-db-endpoints-unsourced-${suffix}`,
    sourcedFinding: `finding-db-endpoints-sourced-${suffix}`,
    unsourcedFinding: `finding-db-endpoints-unsourced-${suffix}`,
  };
  const [alignment] = await queryJson(
    `SELECT wa.id, wa.model_version_id
       FROM word_alignments wa
       JOIN recitation_sessions rs ON rs.id = wa.session_id AND rs.tenant_id = wa.tenant_id
      WHERE wa.tenant_id = $1
        AND rs.learner_id = 'learner-1'
      ORDER BY wa.id
      LIMIT 1`,
    [TENANT],
  );
  assert.ok(alignment, "the migrated seed must provide an alignment for the declared fixtures");

  await queryJson(
    `INSERT INTO audit_events
       (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     VALUES
       ($1, $2, 'teacher-1', 'test.seed', 'declared_acoustic_fixture', $3,
        '{"declaredFixture":true}'::jsonb),
       ($4, $2, 'teacher-1', 'test.seed', 'declared_acoustic_fixture', $5,
        '{"declaredFixture":true}'::jsonb)`,
    [
      ids.sourcedAudit,
      TENANT,
      ids.sourcedFinding,
      ids.unsourcedAudit,
      ids.unsourcedFinding,
    ],
  );
  await insertDeclaredTestAcousticFinding({
    id: ids.sourcedFinding,
    alignmentId: alignment.id,
    rule: "declared-fixture-rule",
    severity: "practice",
    confidence: 0.9,
    explanation: "Declared acoustic fixture for the teacher-review contract",
    sources: [{ id: "fixture-source", title: "Declared test source", citation: "fixture" }],
    auditEventId: ids.sourcedAudit,
  });
  await insertDeclaredTestAcousticFinding({
    id: ids.unsourcedFinding,
    alignmentId: alignment.id,
    rule: "declared-unsourced-fixture-rule",
    severity: "practice",
    confidence: 0.9,
    explanation: "Declared unsourced acoustic fixture for the refusal contract",
    auditEventId: ids.unsourcedAudit,
  });
  return ids;
}

async function cleanupAcousticReviewFixtures(ids) {
  if (!ids) return;
  const findingIds = [ids.sourcedFinding, ids.unsourcedFinding];
  const reviewAudits = await queryJson(
    `DELETE FROM teacher_reviews
      WHERE finding_id = ANY($1::text[])
      RETURNING audit_event_id`,
    [findingIds],
  );
  await queryJson("DELETE FROM tajweed_findings WHERE id = ANY($1::text[])", [findingIds]);
  for (const row of reviewAudits) {
    await queryJson("DELETE FROM audit_events WHERE id = $1", [row.audit_event_id]);
  }
  await queryJson("DELETE FROM audit_events WHERE id = ANY($1::text[])", [
    [ids.sourcedAudit, ids.unsourcedAudit],
  ]);
}

async function reviewFixtureSession() {
  const [session] = await queryJson(
    `SELECT wa.session_id AS id, rs.learner_id
       FROM tajweed_findings tf
       JOIN word_alignments wa ON wa.id = tf.alignment_id
       JOIN recitation_sessions rs ON rs.id = wa.session_id
      WHERE tf.id = $1 AND tf.tenant_id = $2`,
    [reviewFixtures.sourcedFinding, TENANT],
  );
  assert.ok(session, "the declared acoustic fixture must be attached to a real session");
  return session;
}

test("POST /v1/teacher-reviews records a review against a real finding", async () => {
  const finding = { id: reviewFixtures.sourcedFinding };

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
    // ADR-0031: null on a review this fresh, an RFC3339 stamp once a re-record detaches it.
    "supersededAt",
    "teacherId",
    "tenantId",
  ]);
  assert.equal(res.body.findingId, finding.id);
  assert.equal(res.body.supersededAt, null);
  assert.equal(res.body.decision, "accepted");
  assert.ok(res.body.auditEventId, "a review is an accountable act — it must carry its audit row");
});

/**
 * ADR-0027 — the decision reaches the finding.
 *
 * integration.rs:4076 — teacher_decision_promotes_the_finding_and_edited_promotes_nothing
 *
 * Black-box, against whichever implementation is under test, which is the point: `review.rs` and
 * `node-api/routes/review.mjs` both promote, and a port that recorded the review without promoting
 * would pass every other assertion in this file while quietly leaving the teacher's decision
 * without effect.
 *
 * Each case SETS the starting status first rather than relying on the seed, so the three are
 * order-independent and do not inherit whatever the tests above left behind.
 */
test("POST /v1/teacher-reviews promotes the finding, and `edited` promotes nothing", async () => {
  const finding = { id: reviewFixtures.sourcedFinding };

  const statusOf = async () =>
    (await queryJson("SELECT review_status FROM tajweed_findings WHERE id = $1", [finding.id]))[0]
      .review_status;
  const reset = () =>
    queryJson("UPDATE tajweed_findings SET review_status = 'ai-suggested' WHERE id = $1", [
      finding.id,
    ]);
  const decide = async (decision) => {
    const res = await request(api.baseUrl, "/v1/teacher-reviews", {
      method: "POST",
      role: "teacher",
      body: reviewBody({ findingId: finding.id, decision }),
    });
    assert.equal(res.status, 200, `${decision} was not recorded`);
  };

  await reset();
  await decide("accepted");
  assert.equal(await statusOf(), "teacher-reviewed", "accepted must clear the learner gate's status term");

  await reset();
  await decide("rejected");
  assert.equal(await statusOf(), "blocked", "rejected must be distinguishable from unreviewed");

  await reset();
  await decide("edited");
  assert.equal(
    await statusOf(),
    "ai-suggested",
    "edited has nowhere to store the rewrite, so promoting would publish the original wording",
  );

  await reset();
});

test("POST /v1/teacher-reviews cannot forge authorship by supplying another teacherId", async () => {
  // review.rs binds the author to the ACTOR, never to the caller-supplied field — the authorship
  // forgery fixed in 1675d62. Sending admin-1 while acting as teacher-1 must not be honoured.
  const finding = { id: reviewFixtures.sourcedFinding };
  const res = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: finding.id, decision: "rejected", teacherId: "admin-1" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.teacherId, "teacher-1", "a supplied teacherId must be ignored, not honoured");
});

/**
 * ADR-0027 item 6 — a teacher cannot release a finding with nothing behind it.
 *
 * integration.rs:4654 — accepting_an_unsourced_finding_is_refused_but_rejecting_it_is_not
 *
 * The refusal message is wire contract: both implementations must return the SAME string, because a
 * client that branches on it would otherwise behave differently depending on which one answered.
 */
test("POST /v1/teacher-reviews refuses to ACCEPT a finding with no sources", async () => {
  const finding = { id: reviewFixtures.unsourcedFinding };

  const res = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: finding.id, decision: "accepted" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no source/, "the refusal must name the reason");

  // Rejecting the same finding is exactly what a teacher SHOULD be able to do with it.
  const rejected = await request(api.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: reviewBody({ findingId: finding.id, decision: "rejected" }),
  });
  assert.equal(rejected.status, 200, "an unsourced finding must not be trapped in the queue");
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

test("POST /v1/recitation-sessions refuses caller-selected model identity", async () => {
  const res = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: sessionBody({ modelVersion: "model-v0.3" }),
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.text}`);
  assert.match(res.body.error, /server-selected.*must not be supplied/);
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

test("alignments inherit the session model and refuse every caller identity", async () => {
  const [session] = await queryJson(
    `SELECT id, model_version_id FROM recitation_sessions
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

  const stored = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: { alignments: [alignment] },
  });
  assert.equal(stored.status, 200);
  const rows = await queryJson(
    "SELECT DISTINCT model_version_id FROM word_alignments WHERE session_id = $1",
    [session.id],
  );
  assert.deepEqual(
    rows.map((r) => r.model_version_id),
    [session.model_version_id],
    "the alignment must inherit the server selection already stored on the session",
  );

  // Even the correct current value is caller authority when it arrives in a request.
  const rejected = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: { alignments: [alignment], modelVersion: session.model_version_id },
  });
  assert.equal(rejected.status, 400, `expected 400, got ${rejected.status} ${rejected.text}`);
  assert.match(rejected.body.error, /server-selected.*must not be supplied/);
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

// ── the pilot-session idle-expiry roll, under real RLS ─────────────────────────────────────────

/**
 * The mechanism behind an audit finding: `auth.rs` rolled `pilot_sessions.idle_expires_at` on the
 * RAW POOL, with no `app.tenant_id` set — because the session lookup deliberately goes through a
 * SECURITY DEFINER function (the caller has no tenant context yet at auth time).
 *
 * `pilot_sessions` has FORCE ROW LEVEL SECURITY and a `tenant_id = app.current_tenant_id()` policy,
 * so under the restricted production role that UPDATE matched ZERO rows — silently. Every request
 * looked like it rolled the session; the session actually expired 8 hours after bootstrap no matter
 * how active the learner was.
 *
 * It passed every test because `integration.rs`'s pool sets the tenant GUC in `after_connect`, so
 * the policy was satisfied there and only there. This asserts the mechanism directly, with
 * `SET LOCAL ROLE` so it is decisive even on CI, whose DATABASE_URL is a superuser that would
 * otherwise bypass RLS unconditionally and let the test pass against the bug.
 */
test("rolling a pilot session's idle expiry REQUIRES tenant context under RLS", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `pilot-session-rls-${suffix}`;

  // Seed with the harness's tenant context, as the app itself would.
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO pilot_sessions (id, tenant_id, learner_id, token_hash, csrf_token,
                                   last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, 'learner-1', $3, 'csrf-probe', now(),
               now() + interval '8 hours', now() + interval '30 days')`,
      [sessionId, TENANT, `hash-${suffix}`],
    );
  });

  const rollAs = (withContext) =>
    withDb(
      async (client) => {
        await client.query("BEGIN");
        // Without this, CI's superuser DATABASE_URL bypasses RLS and the UPDATE succeeds either
        // way — the test could never fail, whatever the policy said.
        await client.query(`SET LOCAL ROLE ${RLS_PROBE_ROLE}`);
        if (withContext) {
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
        }
        const res = await client.query(
          `UPDATE pilot_sessions SET last_seen_at = now(), idle_expires_at = now() + interval '8 hours'
           WHERE id = $1 AND tenant_id = $2`,
          [sessionId, TENANT],
        );
        await client.query("COMMIT");
        return res.rowCount;
      },
      // tenant: null — this test supplies its own context on purpose; the harness default would
      // set it session-wide and mask exactly the failure being asserted.
      { tenant: null },
    );

  assert.equal(
    await rollAs(false),
    0,
    "WITHOUT tenant context the roll silently affects zero rows — this is the bug, and it is why " +
      "auth.rs now runs inside begin_tenant_tx AND asserts rows_affected() == 1",
  );
  assert.equal(await rollAs(true), 1, "WITH tenant context the roll lands");

  await withDb((client) => client.query("DELETE FROM pilot_sessions WHERE id = $1", [sessionId]));
});

test("a pilot-cookie request actually MOVES the session's idle expiry", async () => {
  // End to end, and the only observable difference between the fixed and broken handler. The broken
  // version returned 200 and rolled nothing, so a success assertion would have passed against it —
  // the expiry timestamp is what tells them apart.
  //
  // Decisive only when the API runs as a role RLS applies to. Locally DATABASE_URL is quran_ai_app,
  // so it bites; on CI it is the superuser, where this passes without proving anything. The
  // SQL-level test above is the one that is decisive in both, and auth.rs's rows_affected() == 1
  // assertion is what makes a recurrence loud rather than silent.
  const minted = await request(api.baseUrl, "/v1/pilot/invitations", {
    method: "POST",
    role: "admin",
    body: { learnerId: "learner-1" },
  });
  assert.equal(minted.status, 200, `minting an invitation failed: ${minted.text}`);
  const inviteToken = minted.body.token ?? minted.body.inviteToken;
  assert.ok(inviteToken, `no invite token in ${JSON.stringify(minted.body)}`);

  const booted = await request(api.baseUrl, "/v1/pilot/session/bootstrap", {
    method: "POST",
    tenant: null,
    headers: { origin: "http://localhost:5173" },
    body: { token: inviteToken },
  });
  assert.equal(booted.status, 200, `bootstrap failed: ${booted.text}`);
  const setCookie = booted.headers.getSetCookie().find((c) => c.startsWith("__Host-qrai-pilot="));
  assert.ok(setCookie, "bootstrap must set the pilot cookie");
  const cookie = setCookie.split(";")[0];
  const csrf = booted.body.csrfToken;

  const expiryOf = async () => {
    const [row] = await queryJson(
      `SELECT idle_expires_at FROM pilot_sessions
       WHERE learner_id = 'learner-1' AND tenant_id = $1
       ORDER BY last_seen_at DESC LIMIT 1`,
      [TENANT],
    );
    return row?.idle_expires_at?.valueOf();
  };
  const before = await expiryOf();
  assert.ok(before, "the bootstrapped session must exist");

  // The roll is `now() + 8h`, so the clock has to move for the value to change.
  await new Promise((r) => setTimeout(r, 1100));
  const authed = await request(api.baseUrl, "/v1/learner/progress", {
    tenant: null,
    headers: { cookie, origin: "http://localhost:5173", "x-csrf-token": csrf },
  });
  assert.equal(authed.status, 200, `the pilot cookie must authenticate: ${authed.text}`);

  const after = await expiryOf();
  assert.ok(
    after > before,
    `idle_expires_at did not move (${before} -> ${after}) — the session is not being kept alive, ` +
      `so an active learner is logged out 8 hours after bootstrap regardless of activity`,
  );
});

// Registered last: node:test runs `after` hooks in registration order, so this drains the rows once
// the hooks above have stopped the services still able to write them.
after(async () => {
  const left = await purgeSessionsByChecksum(RUN_CK_P32);
  assert.equal(left, 0, `teardown left ${left} session(s) behind`);
});

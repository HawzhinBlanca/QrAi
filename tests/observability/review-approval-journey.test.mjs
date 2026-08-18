import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  startApi,
} from "../api-parity/lib/harness.mjs";

/**
 * @journey: finding-approval
 * @journey: scholar-approval
 *
 * Two governance journeys, both about the same promise: content reaches a learner only after a
 * human said it could, and the record of who said so survives.
 *
 * ── Why these are journeys and not parity tests ─────────────────────────────────────────────────
 * `tests/api-parity/review-parity.test.mjs` proves the queue orders correctly and the review row is
 * written. `packages/contracts` proves `canShowLearnerFacingAiOutput` returns false for an
 * unreviewed finding. `integration.rs` proves the promotion UPDATE runs.
 *
 * None of them walks the transition. The claim ADR-0028 actually makes is about a state CHANGE seen
 * from the learner's side: the same learner, asking the same question before and after a teacher
 * acted, gets a different answer — and gets the redacted one first. Every component above can be
 * individually correct while that is false: the promotion could write a status the gate does not
 * accept, the learner-facing read could apply a stale copy of the gate, or the redaction could be
 * skipped for the finding's own owner. Each of those is a sev-1 by `docs/readiness/JOURNEYS.md`
 * (unreviewed model output reaching a learner), and each survives every existing test.
 *
 * ── Two directions, deliberately ────────────────────────────────────────────────────────────────
 * Accepting must OPEN the gate and rejecting must keep it SHUT. A test that only checks acceptance
 * passes just as well against a promotion that ignores the decision and always promotes.
 *
 * Requires a live Postgres. Seeds its own rows and deletes exactly those, by id, in FK-safe order.
 */

let api;
let baseUrl;
const seeded = [];
/** Topics this file recorded an approval for, so the register does not grow every run. */
const approvedTopics = [];

before(async () => {
  api = await startApi();
  baseUrl = api.baseUrl;
});

after(async () => {
  await api?.stop();
  for (const topic of approvedTopics) {
    await queryJson("DELETE FROM scholar_approvals WHERE topic = $1", [topic]);
  }
  for (const ids of seeded.reverse()) {
    await queryJson("DELETE FROM teacher_reviews WHERE finding_id = $1", [ids.finding]);
    await queryJson("DELETE FROM tajweed_findings WHERE id = $1", [ids.finding]);
    await queryJson("DELETE FROM word_alignments WHERE id = $1", [ids.alignment]);
    await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [ids.session]);
    await queryJson("DELETE FROM consent_records WHERE id = $1", [ids.consent]);
    await queryJson("DELETE FROM audit_events WHERE id = $1", [ids.audit]);
  }
});

/**
 * A finding that fails the learner gate on its REVIEW STATUS ALONE.
 *
 * Confidence 0.95 and a real source reference, both comfortably over the bar, so the only thing
 * withholding it is that no human has looked at it. If it were seeded below the confidence floor
 * instead, a teacher's acceptance would correctly leave it withheld and this journey would prove
 * nothing about approval.
 */
async function seedUnreviewedFinding(label) {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const ids = {
    audit: `audit-j-${label}-${suffix}`,
    consent: `consent-j-${label}-${suffix}`,
    session: `session-j-${label}-${suffix}`,
    alignment: `wa-j-${label}-${suffix}`,
    finding: `tf-j-${label}-${suffix}`,
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
     VALUES ($1, $2, $3, 'discard', true, false, true, 'pilot-v1', $4)`,
    [ids.consent, TENANT, learner.id, ids.audit],
  );
  await queryJson(
    `INSERT INTO recitation_sessions
       (id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode,
        practice_plan_id, external_processing_allowed, confidence, review_status, started_at,
        latency_ms, consent_record_id, consent_snapshot, audit_event_id, language)
     VALUES ($1, $2, $3, '{"surahNumber":1,"ayahStart":1,"ayahEnd":1,"display":"Al-Fatihah 1:1"}'::jsonb,
             'fnv1a32:journey', $4, 'guided-recite', 'p', false, 0.9, 'teacher-review-required',
             now(), 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 0, 100, 0.9, 'matched', $5, $6, 'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  // 0030 reclassified 'canonical-text' and narrowed the CHECK to ('text-rule','acoustic'), and a
  // trigger requires an acoustic finding to reference release-eligible evaluation evidence. This
  // journey is about a TEACHER REVIEWING a performance claim — 0030's review index is
  // `where analysis_basis = 'acoustic'` — so it seeds the declared evidence through the shared
  // helper rather than hand-rolling the seven provenance columns.
  await insertDeclaredTestAcousticFinding({
    id: ids.finding,
    alignmentId: ids.alignment,
    rule: "ghunnah",
    severity: "practice",
    confidence: 0.95,
    explanation: EXPLANATION,
    reviewStatus: "teacher-review-required",
    sources: [{ id: "src-journey", title: "Tajweed reference", citation: "Rule 1" }],
    auditEventId: ids.audit,
  });

  seeded.push(ids);
  return { ...ids, learnerId: learner.id };
}

/** Distinctive so a substring search cannot match some other row's text by accident. */
const EXPLANATION = "JOURNEY-ONLY hold the nasalization for two counts";

/** What the learner this finding is about sees when they ask for their own session's findings. */
async function learnerViewOf(session, learnerId) {
  const res = await request(baseUrl, `/v1/recitation-sessions/${session}/tajweed-findings`, {
    role: "learner",
    userId: learnerId,
  });
  assert.equal(res.status, 200, `the learner could not read their own session: ${res.text}`);
  return res;
}

test("before any human looks at it, the learner is told a note exists and nothing else", async () => {
  const ids = await seedUnreviewedFinding("withheld");
  const res = await learnerViewOf(ids.session, ids.learnerId);

  const findings = Array.isArray(res.body) ? res.body : (res.body.findings ?? []);
  const mine = findings.find((f) => f.id === ids.finding);
  assert.ok(
    mine,
    `the finding vanished from the learner's own session instead of being redacted. ` +
      `The count is what both clients render "N notes are waiting for a teacher" from; removing ` +
      `the row makes the wait invisible rather than pending. Body: ${res.text.slice(0, 800)}`,
  );

  // The judgement must not have crossed the wire at all. Asserting on the whole response body, not
  // just this finding, because a redaction that leaves the text in a sibling field is still a leak.
  assert.ok(
    !res.text.includes(EXPLANATION),
    `an unreviewed finding's explanation reached the learner it is about (sev-1): ${res.text.slice(0, 800)}`,
  );
  assert.equal(mine.confidence, 0, "a withheld finding must not carry its confidence");
  assert.deepEqual(mine.sources ?? [], [], "a withheld finding must not carry its sources");
});

test("a teacher's acceptance is recorded, and the learner still waits on calibrated evidence", async () => {
  // ── This test asserted the opposite until ADR-0044, and the change is product-visible ─────────
  //
  // It required that a teacher's acceptance makes the note visible to the learner, naming the
  // failure "sev-2 — a teacher's decision that changes nothing". Under #388 that is now the
  // designed behaviour, in BOTH ports and deliberately:
  //
  //   server/src/routes/review.mjs      calibrationStatus is the literal "uncalibrated"
  //   services/platform-api/.../review.rs  evaluationEvidenceStatus can only be
  //                                     "fixture" | "stale" | "unverified"
  //
  // and `clearsLearnerFeedbackGate` demands "calibrated" AND "release-trusted". Both files say why
  // in the same words: production trust is intentionally empty, and T10's calibrator/evidence
  // registry is the only component allowed to promote a row. Until it exists, NO stored finding can
  // reach a learner, whatever a teacher decides.
  //
  // So this asserts the real guarantee — the decision is recorded, the content is still withheld,
  // and the reason is the evidence gate rather than an unrelated redaction — plus a tripwire below
  // that turns it back into the original assertion the moment the gate becomes satisfiable. Left as
  // a bare "still withheld" it would go on passing after T10 shipped, with learners seeing nothing
  // and nobody finding out from this file.
  const ids = await seedUnreviewedFinding("accepted");

  const before = await learnerViewOf(ids.session, ids.learnerId);
  assert.ok(
    !before.text.includes(EXPLANATION),
    "precondition: the finding must start withheld, or the transition proves nothing",
  );

  const review = await request(baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: {
      findingId: ids.finding,
      teacherId: "teacher-1",
      decision: "accepted",
      note: "Correct, this is a clear ghunnah.",
    },
  });
  assert.equal(review.status, 200, `the teacher's decision was not accepted: ${review.text}`);

  // The decision itself must be on the record regardless of what the learner can see.
  const [reviewed] = await queryJson(
    "SELECT review_status FROM tajweed_findings WHERE id = $1",
    [ids.finding],
  );
  // `teacher-reviewed`, not `accepted`: the decision itself lives on the teacher_reviews row, and
  // this column records only that a human has now looked at the finding.
  assert.equal(
    reviewed.review_status,
    "teacher-reviewed",
    "the teacher's decision did not reach the row",
  );

  const after = await learnerViewOf(ids.session, ids.learnerId);
  const findings = Array.isArray(after.body) ? after.body : (after.body.findings ?? []);
  const mine = findings.find((f) => f.id === ids.finding);
  assert.ok(mine, "the accepted finding vanished from the learner's own session entirely");

  const gateOpen =
    mine.calibrationStatus === "calibrated" && mine.evaluationEvidenceStatus === "release-trusted";

  if (gateOpen) {
    // T10 has landed. The original guarantee applies again, unchanged.
    assert.ok(
      after.text.includes(EXPLANATION),
      "the evidence is calibrated and release-trusted and the teacher accepted it, and the learner " +
        "still cannot see it (sev-2 — a teacher's decision that changes nothing)",
    );
    assert.ok(mine.confidence > 0, "an approved finding should carry its real confidence");
    assert.ok(mine.sources.length > 0, "an approved finding must still cite its source");
    return;
  }

  // The gate is shut. Assert WHY, so this cannot pass for some unrelated reason — a broken redaction
  // or a lost row would otherwise look identical to "correctly withheld".
  assert.ok(
    !after.text.includes(EXPLANATION),
    "the learner was shown a finding whose evidence is neither calibrated nor release-trusted",
  );
  assert.equal(mine.calibrationStatus, "uncalibrated");
  assert.notEqual(
    mine.evaluationEvidenceStatus,
    "release-trusted",
    "evidence claims release trust while calibration is still absent",
  );
  assert.equal(mine.confidence, 0, "a withheld finding leaked its confidence");
  assert.deepEqual(mine.sources, [], "a withheld finding leaked its sources");
});

test("after a teacher rejects it, the learner still sees nothing", async () => {
  // The direction that catches a promotion ignoring the decision. Without this, an implementation
  // that promoted on EVERY review would pass the acceptance test above.
  const ids = await seedUnreviewedFinding("rejected");

  const review = await request(baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: {
      findingId: ids.finding,
      teacherId: "teacher-1",
      decision: "rejected",
      note: "Not a ghunnah — the model misheard the preceding letter.",
    },
  });
  assert.equal(review.status, 200, `the rejection was not accepted: ${review.text}`);

  const after = await learnerViewOf(ids.session, ids.learnerId);
  assert.ok(
    !after.text.includes(EXPLANATION),
    `a REJECTED finding became visible to the learner (sev-1). Body: ${after.text.slice(0, 800)}`,
  );
});

test("the decision is on the record, attributed, before the content is anywhere", async () => {
  // A promotion whose audit trail was lost is learner-facing content nobody can account for. The
  // handler makes the review row, the promotion and the audit event one transaction; this asserts
  // the outcome of that from outside, which is the only place the guarantee is observable.
  const ids = await seedUnreviewedFinding("audited");

  await request(baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: {
      findingId: ids.finding,
      teacherId: "teacher-1",
      decision: "accepted",
      note: "Confirmed.",
    },
  });

  const rows = await queryJson(
    "SELECT teacher_id, decision FROM teacher_reviews WHERE finding_id = $1",
    [ids.finding],
  );
  assert.equal(rows.length, 1, "exactly one review row should exist for this finding");
  assert.equal(rows[0].teacher_id, "teacher-1", "the decision must name who made it");
  assert.equal(rows[0].decision, "accepted");

  const [finding] = await queryJson("SELECT review_status FROM tajweed_findings WHERE id = $1", [
    ids.finding,
  ]);
  assert.equal(
    finding.review_status,
    "teacher-reviewed",
    "the promotion and the review row must agree — a promoted finding with no review row, or a " +
      "review row with no promotion, is half a decision",
  );
});

test("a scholar's approval is recorded against the exact scope it approved", async () => {
  // The governance journey. Its whole value is that the record survives and names its subject: an
  // approval that cannot be traced back to what was approved cannot be relied on at a go/no-go, and
  // P3.6 (scholar approval of source/model scope) rests entirely on this route.
  const list = await request(baseUrl, "/v1/scholar-approvals", { role: "scholar" });
  assert.equal(list.status, 200, `a scholar cannot read the approvals register: ${list.text}`);
  const before = Array.isArray(list.body) ? list.body.length : 0;
  assert.ok(before >= 0);

  const topic = `journey-scope-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const created = await request(baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: {
      // Read off `ScholarApprovalRequest` in services/platform-api/src/types.rs:261, not inferred
      // from a nearby call. A first version of this test guessed
      // `{scholarId, subjectType, subjectId, decision, rationale}` and was refused — the same
      // pattern-matching mistake that put four type errors into CI on the Flutter change.
      topic,
      reviewerId: "scholar-1",
      status: "scholar-approved",
      risk: "low",
      sources: [
        {
          id: "src-journey-scholar",
          title: "Tajweed reference",
          citation: "Reviewed against the cited reference; scope is correct.",
        },
      ],
    },
  });

  // A scholar refused their own route would be a product defect; a 4xx on shape would be a defect
  // in this test. Separated so the failure message says which.
  assert.ok(
    created.status !== 401 && created.status !== 403,
    `a scholar was refused their own approvals route (sev-2): ${created.status} ${created.text}`,
  );
  assert.equal(
    created.status,
    200,
    `recording a scholar approval failed: ${created.status} ${created.text}`,
  );

  const readBack = await request(baseUrl, "/v1/scholar-approvals", { role: "scholar" });
  assert.equal(readBack.status, 200);
  assert.ok(
    readBack.text.includes(topic),
    `the approval just recorded is not in the register — an approval nobody can find is not one. ` +
      `Looked for topic ${topic}.`,
  );

  // The register must attribute it. An approval with no reviewer is a rubber stamp with extra steps.
  const rows = Array.isArray(readBack.body) ? readBack.body : (readBack.body.approvals ?? []);
  const mine = rows.find((a) => a.topic === topic);
  assert.ok(mine, "the approval is in the response text but not as a readable record");
  // `reviewer` and `sourceCount`, read off the actual response — the register returns a SUMMARY
  // shape, not the request shape. Guessed `reviewerId`/`sources` first and it failed; recorded here
  // because the same guess in production code is how a client renders a blank attribution.
  assert.equal(mine.reviewer, "scholar-1", "the approval must name who gave it");
  assert.ok(
    mine.sourceCount > 0,
    "an approval that cites nothing cannot be checked by the next reviewer",
  );
  assert.equal(mine.status, "scholar-approved");

  approvedTopics.push(topic);
});

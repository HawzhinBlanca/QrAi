/**
 * N15 — the review gates: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of handlers/review.rs
 *
 *   NODE_API_PORTED="GET /v1/tajweed-findings,POST /v1/teacher-reviews,GET /v1/teacher-review-queue,GET /v1/scholar-approvals,POST /v1/scholar-approvals" \
 *     node --test tests/api-parity/review-parity.test.mjs
 *
 * ── The rule these routes exist to enforce ──────────────────────────────────────────────────────
 * No learner-facing AI feedback without a source, a confidence, and a human approval. Two of the
 * five operations are where that becomes a refusal rather than a policy: `scholar-approved` with no
 * sources, and `scholar-approved` at high risk. Both are 400s, both are checked BEFORE anything is
 * written, and both are asserted here against the database as well as the response — a refused
 * approval must leave NO row, not a row someone later reads as an approval that was considered.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB, assertABMutating } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

let api;
let shell;
let findingId;

before(async () => {
  api = await startApi({});
  shell = await startShell({ upstream: api.baseUrl });
  const [f] = await queryJson(
    "SELECT id FROM tajweed_findings WHERE tenant_id = $1 ORDER BY id LIMIT 1",
    [TENANT],
  );
  findingId = f?.id ?? null;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const ROLES = ["learner", "teacher", "scholar", "admin", "ops"];

const source = (id = "s1") => ({ id, title: "Tajweed rule", citation: "ref", url: null });

const approvalBody = (overrides = {}) => ({
  topic: "ghunnah",
  reviewerId: "someone-else-entirely",
  status: "draft",
  risk: "low",
  sources: [source()],
  ...overrides,
});

// ── the three read routes ──────────────────────────────────────────────────────────────────────

test("GET /v1/tajweed-findings is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/tajweed-findings", role });
  }
});

test("GET /v1/teacher-review-queue is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/teacher-review-queue", role });
  }
});

test("GET /v1/scholar-approvals is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/scholar-approvals", role });
  }
});

test("the three read routes have THREE different role lists", async () => {
  const status = async (path, role) => (await request(shell.baseUrl, path, { role })).status;

  // findings: teacher, scholar, admin, ops
  assert.equal(await status("/v1/tajweed-findings", "learner"), 403);
  assert.equal(await status("/v1/tajweed-findings", "scholar"), 200);
  assert.equal(await status("/v1/tajweed-findings", "teacher"), 200);

  // queue: teacher, admin, ops — NO scholar
  assert.equal(await status("/v1/teacher-review-queue", "scholar"), 403, "a scholar is not a teacher");
  assert.equal(await status("/v1/teacher-review-queue", "teacher"), 200);

  // approvals READ: scholar, teacher, admin, ops — a teacher may READ what a scholar approved…
  assert.equal(await status("/v1/scholar-approvals", "teacher"), 200);
  assert.equal(await status("/v1/scholar-approvals", "learner"), 403);
});

test("a teacher may READ approvals but not CREATE one", async () => {
  // …and this is the asymmetry that makes it worth stating: the read list includes teacher, the
  // create list does not.
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "teacher creates a scholar approval",
    probeFor: () => ({
      path: "/v1/scholar-approvals",
      method: "POST",
      role: "teacher",
      body: approvalBody(),
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 403);
});

test("the scholar-approvals LIST shape is a count, not the sources themselves", async () => {
  const res = await request(shell.baseUrl, "/v1/scholar-approvals", { role: "admin" });
  assert.equal(res.status, 200);
  if (res.body.length === 0) return;
  assert.deepEqual(Object.keys(res.body[0]), [
    "id",
    "reviewer",
    "risk",
    "sourceCount",
    "status",
    "topic",
  ], "note `reviewer`, not `reviewerId`, and a COUNT — this is not the ScholarApproval struct");
});

test("tajweed-findings key order is alphabetical, and the sort has a unique tiebreaker", async () => {
  const res = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "admin" });
  assert.equal(res.status, 200);
  if (res.body.length === 0) return;
  assert.deepEqual(Object.keys(res.body[0]), [
    // ADR-0033: what the finding is ABOUT. Today always `canonical-text` — the analyser reads the
    // passage's Uthmani text, so a finding is "a rule applies here", not "you recited this wrongly".
    "analysisBasis",
    // Whether a reviewer can HEAR the recitation this finding is about, and if not, why not.
    "audioStatus",
    "confidence",
    "explanation",
    "id",
    "reviewStatus",
    "rule",
    "severity",
    "sources",
    // ADR-0030: what this finding's evidence rests on. A finding anchored to a `client-reported`
    // alignment rests on words the learner's browser supplied; promoting it to teacher-reviewed
    // makes it learner-visible feedback about a recitation nobody can show happened.
    "transcriptSource",
    "wordId",
  ]);

  // `ORDER BY confidence DESC, id` — confidence is NOT unique, so without the id tiebreaker the
  // LIMIT drops an arbitrary subset of the tied rows and the endpoint returns a different set run
  // to run. Two consecutive calls must agree.
  const again = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "admin" });
  assert.deepEqual(
    again.body.map((f) => f.id),
    res.body.map((f) => f.id),
    "two consecutive reads returned different findings — the ORDER BY needs a unique tiebreaker",
  );
});

// ── the two refusals ───────────────────────────────────────────────────────────────────────────

/**
 * THE gate. `scholar-approved` with no sources is refused, and nothing is written.
 *
 * Asserting the 400 alone is not enough: a handler that inserted the row and THEN failed would
 * still answer 400 while leaving an approval in the table for someone to read later. The row count
 * is checked before and after.
 */
test("scholar-approved with NO sources is 400, and writes nothing", async () => {
  const before = await queryJson(
    "SELECT COUNT(*)::int AS n FROM scholar_approvals WHERE tenant_id = $1",
    [TENANT],
  );

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "approve with no sources",
    probeFor: () => ({
      path: "/v1/scholar-approvals",
      method: "POST",
      role: "scholar",
      body: approvalBody({ status: "scholar-approved", sources: [] }),
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400);
  assert.equal(s.body.error, "source references are required for scholar-approved content");

  const after = await queryJson(
    "SELECT COUNT(*)::int AS n FROM scholar_approvals WHERE tenant_id = $1",
    [TENANT],
  );
  assert.equal(after[0].n, before[0].n, "a refused approval must leave NO row behind");
});

test("scholar-approved at HIGH risk is 400, and writes nothing", async () => {
  const before = await queryJson(
    "SELECT COUNT(*)::int AS n FROM scholar_approvals WHERE tenant_id = $1",
    [TENANT],
  );

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "approve high-risk content",
    probeFor: () => ({
      path: "/v1/scholar-approvals",
      method: "POST",
      role: "scholar",
      body: approvalBody({ status: "scholar-approved", risk: "high" }),
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400);
  assert.equal(s.body.error, "high-risk content cannot be auto-approved");

  const after = await queryJson(
    "SELECT COUNT(*)::int AS n FROM scholar_approvals WHERE tenant_id = $1",
    [TENANT],
  );
  assert.equal(after[0].n, before[0].n);
});

test("the two refusals apply ONLY to scholar-approved — draft and blocked are unaffected", async () => {
  for (const status of ["draft", "blocked"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `${status} with no sources at high risk`,
      probeFor: () => ({
        path: "/v1/scholar-approvals",
        method: "POST",
        role: "scholar",
        body: approvalBody({ status, risk: "high", sources: [] }),
      }),
      normalize: (b) =>
        b && typeof b === "object" && b.id ? { ...b, id: "<ID>", auditEventId: "<A>" } : b,
    });
    assert.equal(s.status, 200, `${status} is not an approval and must not be gated`);
  }
});

test("when BOTH refusals apply, the SOURCES message wins — the order is contract", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "approve high-risk with no sources",
    probeFor: () => ({
      path: "/v1/scholar-approvals",
      method: "POST",
      role: "scholar",
      body: approvalBody({ status: "scholar-approved", risk: "high", sources: [] }),
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 400);
  assert.equal(
    s.body.error,
    "source references are required for scholar-approved content",
    "a client branching on the message would see it change if the checks were reordered",
  );
});

// ── attribution ────────────────────────────────────────────────────────────────────────────────

/**
 * The rule that repeats twice.
 *
 * `reviewerId` and `teacherId` are accepted by the request shapes and then IGNORED. Trusting them
 * let any teacher attribute a review to another user — including a cross-tenant one, because
 * `users(id)` is a platform-global FK. Asserted against the stored ROW, not just the response.
 */
test("the approval reviewer is the AUTHENTICATED actor, never the caller-supplied one", async () => {
  const res = await request(shell.baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: approvalBody({ reviewerId: "definitely-not-me" }),
  });
  assert.equal(res.status, 200, res.text);
  assert.notEqual(res.body.reviewerId, "definitely-not-me");

  const [row] = await queryJson("SELECT reviewer_id FROM scholar_approvals WHERE id = $1", [res.body.id]);
  assert.equal(row.reviewer_id, res.body.reviewerId);
  assert.notEqual(row.reviewer_id, "definitely-not-me", "the STORED row must not carry the claim");
});

test("the approval response is the STRUCT shape — sources in declaration order", async () => {
  const res = await request(shell.baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: approvalBody(),
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), [
    "id",
    "tenantId",
    "topic",
    "reviewerId",
    "status",
    "risk",
    "sources",
    "auditEventId",
  ]);
  assert.deepEqual(Object.keys(res.body.sources[0]), ["id", "title", "citation", "url"]);
  assert.equal(res.body.sources[0].url, null, "an absent url is present-and-null, not omitted");
});

test("a teacher review is attributed to the caller, and needs a REAL finding", async () => {
  if (!findingId) {
    assert.ok(true, "SKIP — no tajweed_findings in this corpus to review");
    return;
  }
  const res = await request(shell.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: { findingId, teacherId: "definitely-not-me", decision: "accepted", note: "ok" },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), [
    "id",
    "tenantId",
    "findingId",
    "teacherId",
    "decision",
    "note",
    // ADR-0031: null while the review is about a live finding, an RFC3339 stamp once a re-record
    // has detached it. Declaration order — serde emits the struct in it and this compares bytes.
    "supersededAt",
    "auditEventId",
  ]);
  assert.notEqual(res.body.teacherId, "definitely-not-me");
  assert.equal(res.body.supersededAt, null, "a review written a moment ago is not superseded");
  assert.equal(res.body.findingId, findingId, "a live review names its finding");

  const [row] = await queryJson("SELECT teacher_id FROM teacher_reviews WHERE id = $1", [res.body.id]);
  assert.equal(row.teacher_id, res.body.teacherId);
});

test("reviewing a nonexistent finding is 404, not a 500 from the FK", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "review a nonexistent finding",
    probeFor: () => ({
      path: "/v1/teacher-reviews",
      method: "POST",
      role: "teacher",
      body: { findingId: "finding-does-not-exist", teacherId: "x", decision: "accepted", note: "" },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 404);
});

test("creating a teacher review is teacher/admin/ops — every other role is refused identically",
  async () => {
    for (const role of ["learner", "scholar", "teacher", "admin", "ops"]) {
      await assertABMutating(shell.baseUrl, api.baseUrl, {
        name: `teacher review as ${role}`,
        probeFor: () => ({
          path: "/v1/teacher-reviews",
          method: "POST",
          role,
          body: {
            findingId: findingId ?? "finding-does-not-exist",
            teacherId: "x",
            decision: "accepted",
            note: "",
          },
        }),
        normalize: (b) =>
          b && typeof b === "object" && b.id ? { ...b, id: "<ID>", auditEventId: "<A>" } : b,
      });
    }
  });


// ── What evidence stands behind a finding a teacher is asked to judge ────────────────────────────
//
// A teacher opening the queue is asked to accept or reject a claim about how a child recited. Until
// this field, nothing told them whether the recording still existed. Measured before it was added:
// all 2772 findings in this corpus belong to sessions whose consent said `discard`, so the audio was
// destroyed by design — and the queue looked exactly the same as if it were sitting there unplayed.
//
//   available     a stored chunk covers this finding's span, and consent permits keeping it
//   discarded     consent said `discard`; the recording was destroyed on purpose
//   not-captured  retention was permitted, but no audio was stored for this span
//   unknown       retention could not be established — never offered for playback
//
// Consent is checked FIRST and is authoritative. A chunk existing under `discard` consent is a
// retention bug, and answering `available` would invite a teacher to listen to a recording that
// should not exist. Fail closed: `discard` means `discarded`, whatever is on disk.
const AUDIO_STATUSES = ["available", "discarded", "not-captured", "unknown"];

test("every finding says whether its audio can be heard, and both implementations agree", async () => {
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", api.baseUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);
    if (res.body.length === 0) continue;
    for (const f of res.body) {
      assert.ok(
        AUDIO_STATUSES.includes(f.audioStatus),
        `${impl}: finding ${f.id} reports audioStatus ${JSON.stringify(f.audioStatus)}, which is ` +
          `not one of ${AUDIO_STATUSES.join("/")}. An unrecognised value is offered to nobody, but ` +
          "it also tells a teacher nothing.",
      );
    }
  }
});

test("a finding whose consent said discard says so — not silence", async () => {
  // The absolute assertion, cross-checked against the database rather than against the other
  // implementation: the A/B cannot see a change applied to both.
  const rows = await queryJson(
    `SELECT tf.id, cr.audio_retention
     FROM tajweed_findings tf
     JOIN word_alignments wa ON wa.id = tf.alignment_id
     JOIN recitation_sessions rs ON rs.id = wa.session_id
     JOIN consent_records cr ON cr.id = rs.consent_record_id
     WHERE tf.tenant_id = $1 AND cr.audio_retention = 'discard'
     LIMIT 25`,
    [TENANT],
  );
  if (rows.length === 0) {
    assert.fail(
      "no discard-consent finding in this tenant, so this test proves nothing. It was written " +
        "against a corpus where ALL 2772 findings were discard — if that changed, re-measure.",
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r.audio_retention]));

  const res = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "teacher" });
  assert.equal(res.status, 200);
  const seen = res.body.filter((f) => byId.has(f.id));
  assert.ok(seen.length > 0, "none of the discard-consent findings came back on the route");
  for (const f of seen) {
    assert.equal(
      f.audioStatus,
      "discarded",
      `finding ${f.id} has audio_retention=discard in the database but the route reports ` +
        `${JSON.stringify(f.audioStatus)}. A teacher would wait for a recording that was destroyed ` +
        "on purpose.",
    );
  }
});

test("the route is teacher-and-above, within tenant — a learner cannot read it", async () => {
  // The access rule this field was built under. Asserted here rather than assumed from the matrix,
  // because it is the rule that decides who may be told a recording exists at all.
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", api.baseUrl]]) {
    assert.equal(
      (await request(base, "/v1/tajweed-findings", { role: "learner" })).status,
      403,
      `${impl}: a learner read the finding queue`,
    );
    assert.equal(
      (await request(base, "/v1/tajweed-findings", { role: "teacher" })).status,
      200,
      `${impl}: a teacher could not read the finding queue`,
    );
  }
});

// ── The review queue must contain the findings that need reviewing ────────────────────────────────
//
// `/v1/tajweed-findings` is the tenant-wide staff queue: what a teacher opens to decide what to work
// on. It was `ORDER BY confidence DESC, id LIMIT 200`, and measured against this corpus that page
// contained:
//
//   115  teacher-reviewed          already decided, 58% of the page
//    84  ai-suggested
//     1  blocked
//     0  teacher-review-required   ...out of 1781 in the tenant
//
// Zero of the findings whose status LITERALLY NAMES the need were visible, and a teacher working the
// queue to exhaustion would never reach one.
//
// I made half of this worse. ADR-0036 set canonical-text confidence to 0 — correctly, it was
// fabricated — which put every NEW finding behind all 2892 legacy ones carrying 0.80-0.90. At the
// time of writing 41 findings had confidence 0 and not one appeared in the page. The ordering was
// already sorting by something unrelated to whether review was needed; zeroing the number turned a
// bad sort into a starvation.
//
// The queue now sorts by what it is FOR: awaiting review before already decided, then OLDEST first
// so nothing starves. An unrecognised review status sorts with "awaiting" — a status nobody has
// heard of should surface for a human, not vanish.
const DECIDED_STATUSES = ["teacher-reviewed", "blocked", "scholar-approved"];

test("the review queue is not full of findings that were already reviewed", async () => {
  const [{ awaiting }] = await queryJson(
    `SELECT count(*)::int AS awaiting FROM tajweed_findings
     WHERE tenant_id = $1 AND review_status NOT IN ('teacher-reviewed','blocked','scholar-approved')`,
    [TENANT],
  );
  assert.ok(
    awaiting > 200,
    `premise: this test needs more awaiting findings than the page holds, got ${awaiting}. ` +
      "With fewer, every one fits and the ordering cannot starve anything.",
  );

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", api.baseUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);
    const decided = res.body.filter((f) => DECIDED_STATUSES.includes(f.reviewStatus));
    assert.equal(
      decided.length,
      0,
      `${impl}: ${decided.length} of ${res.body.length} findings in the queue are already decided ` +
        `while ${awaiting} await review. A teacher cannot reach the work.`,
    );
  }
});

test("findings whose status names the need are actually IN the queue", async () => {
  const [{ n }] = await queryJson(
    `SELECT count(*)::int AS n FROM tajweed_findings
     WHERE tenant_id = $1 AND review_status = 'teacher-review-required'`,
    [TENANT],
  );
  assert.ok(n > 0, "premise: this tenant has no teacher-review-required findings to look for");

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", api.baseUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    const required = res.body.filter((f) => f.reviewStatus === "teacher-review-required");
    assert.ok(
      required.length > 0,
      `${impl}: none of the ${n} teacher-review-required findings appear in the queue`,
    );
  }
});

test("the page is exactly the longest-waiting awaiting findings — not a confidence ranking", async () => {
  // ── A correction to this test's first draft, kept because the distinction is the whole point ────
  //
  // It originally asserted "a zero-confidence finding appears in the queue" and stayed RED after the
  // fix. That premise conflated two different things:
  //
  //   STARVATION  a finding can NEVER be reached however much work is done. Confidence ordering is
  //               static, so a confidence-0 finding sat behind 2892 legacy ones permanently.
  //   BACKLOG     a finding is not on page 1 because 1986 others have waited longer. It advances as
  //               they are worked.
  //
  // Under FIFO the 40 newest findings are legitimately not on the first page, and demanding they be
  // there would have meant ordering newest-first, which starves the oldest instead. So the test was
  // wrong, not the code — and the honest property is that POSITION DEPENDS ON WAITING, not on a
  // number. Cross-checked against Postgres rather than against the other implementation, because an
  // A/B cannot see an ordering both sides get wrong together.
  const expected = await queryJson(
    `SELECT tf.id
     FROM tajweed_findings tf
     JOIN word_alignments wa ON wa.id = tf.alignment_id
     LEFT JOIN recitation_sessions rs ON rs.id = wa.session_id
     WHERE tf.tenant_id = $1
     ORDER BY (tf.review_status IN ('teacher-reviewed','blocked','scholar-approved')),
              rs.started_at ASC NULLS FIRST, tf.id
     LIMIT 200`,
    [TENANT],
  );

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", api.baseUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    assert.deepEqual(
      res.body.map((f) => f.id),
      expected.map((r) => r.id),
      `${impl}: the queue is not the longest-waiting findings. If this went red after an ORDER BY ` +
        "change, decide deliberately which findings become unreachable — with a fixed LIMIT and no " +
        "pagination, some always do.",
    );
  }
});

/**
 * The truncation, stated rather than left to be discovered.
 *
 * `LIMIT 200` with no pagination means a queue deeper than 200 has findings no teacher can reach
 * through this route, whatever the order. Reordering moved WHO is unreachable — from "everything
 * that actually needs review" to "the most recent arrivals" — it did not remove the cap.
 *
 * This test does not fail on the backlog existing; that would be failing on the corpus. It fails if
 * the route ever stops being truncated silently, so whoever adds pagination is told this note is
 * stale, and it prints the depth so the number is visible in the gate rather than in a database.
 */
test("the queue is truncated and nothing on the wire says so — a recorded gap", async () => {
  const [{ awaiting }] = await queryJson(
    `SELECT count(*)::int AS awaiting FROM tajweed_findings
     WHERE tenant_id = $1 AND review_status NOT IN ('teacher-reviewed','blocked','scholar-approved')`,
    [TENANT],
  );
  const res = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "teacher" });
  assert.equal(res.status, 200);

  if (awaiting <= 200) {
    assert.ok(true, `SKIP — only ${awaiting} findings await review, so nothing is truncated here`);
    return;
  }

  assert.equal(
    res.body.length,
    200,
    "the queue stopped returning a full page; if pagination was added, delete this test and the " +
      "note above it rather than leaving a stale claim about truncation",
  );
  assert.ok(
    !Array.isArray(res.body) || res.body.every((f) => !("totalAwaiting" in f)),
    "the response now carries a total — say so on the route and retire this gap",
  );
  // Printed, not asserted: the point is that the number is knowable from the gate.
  console.log(`    note: ${awaiting} findings await review; this route returns at most 200 and says nothing about the rest`);
});

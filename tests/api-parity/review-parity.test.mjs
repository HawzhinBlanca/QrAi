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
let findingId;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl });
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
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/tajweed-findings", role });
  }
});

test("GET /v1/teacher-review-queue is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/teacher-review-queue", role });
  }
});

test("GET /v1/scholar-approvals is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, rustUrl, { path: "/v1/scholar-approvals", role });
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  // Creates the row it needs rather than hoping one exists. `if (empty) return` made this a wire
  // contract that was pinned on a developer's machine and asserted NOTHING on CI, where
  // scholar_approvals is empty: no migration seeds it. A shape assertion that only runs where the
  // gate is not is the wrong way round.
  await request(shell.baseUrl, "/v1/scholar-approvals", {
    method: "POST",
    role: "scholar",
    body: approvalBody(),
  });

  const res = await request(shell.baseUrl, "/v1/scholar-approvals", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(
    res.body.length > 0,
    "an approval was just created and the list is still empty — the route is not reading it back",
  );
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
  // Seeded, for the same reason as the approvals shape above: no migration creates a
  // tajweed_findings row, so on CI this route returns [] and `if (empty) return` turned the wire
  // contract into a green tick. Backdated so it is at the FRONT of the queue and cannot fall off the
  // 200-row page on a machine with a backlog.
  await seedQueued({
    label: "shape",
    reviewStatus: "ai-suggested",
    confidence: 0,
    startedAtSql: "now() - interval '25 years'",
  });

  const res = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(
    res.body.length > 0,
    "a finding was just seeded at the front of the queue and the route returned none",
  );
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

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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

  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
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
      await assertABMutating(shell.baseUrl, rustUrl, {
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
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
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
  // Correlate FROM the route's own page, not toward it. This used to take an arbitrary unordered
  // `LIMIT 25` of discard findings and require them to appear on a page the route caps at 200 — with
  // 3831 findings in the tenant those 25 rarely intersect the page at all, and the test failed
  // reporting a redaction bug that did not exist. Which findings are on the page is the route's
  // business; what it says about the ones it DOES return is this test's.
  const res = await request(shell.baseUrl, "/v1/tajweed-findings", { role: "teacher" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "the route returned no findings at all, so this test proves nothing");

  const rows = await queryJson(
    `SELECT tf.id, cr.audio_retention
     FROM tajweed_findings tf
     JOIN word_alignments wa ON wa.id = tf.alignment_id
     JOIN recitation_sessions rs ON rs.id = wa.session_id
     JOIN consent_records cr ON cr.id = rs.consent_record_id
     WHERE tf.tenant_id = $1 AND cr.audio_retention = 'discard' AND tf.id = ANY($2)`,
    [TENANT, res.body.map((f) => f.id)],
  );
  if (rows.length === 0) {
    assert.fail(
      "the route returned no finding whose consent said discard, so this test proves nothing. It " +
        "was written against a corpus where ALL 2772 findings were discard — if that changed, " +
        "re-measure.",
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r.audio_retention]));
  const seen = res.body.filter((f) => byId.has(f.id));
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
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
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

/**
 * Seed one finding with a controlled review status, confidence, and session age.
 *
 * The first version of these tests asserted against WHATEVER the corpus happened to hold —
 * `awaiting > 200` as a premise. That passed on a machine with a 1986-deep backlog and failed on
 * CI's freshly migrated database, which has ten. A test coupled to one machine's data is a pin on
 * today's state, which is the defect this whole file exists to catch; so the fixtures now state
 * what they need instead of hoping for it.
 *
 * `startedAt` is what the queue orders by, so it is a parameter rather than `now()`.
 */
/**
 * Every row `seedQueued` has created in this process, newest first, for the cleanup below.
 *
 * Without this the helper was a slow poison. It plants a session dated `now() - 18 years` on EVERY
 * run and deleted nothing, so the set of ancient awaiting findings grew by two per run forever.
 * Measured the day it finally mattered: 208 of them, against this route's `LIMIT 200`. The freshly
 * seeded pair then lands among 208 same-era rows tie-broken by UUID and falls off page one at
 * random — a test that had been quietly loading the gun for months and fired locally while CI, whose
 * database is fresh every time, kept passing.
 */
const seeded = [];

async function seedQueued({ label, reviewStatus, confidence, startedAtSql }) {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  const ids = {
    audit: `audit-q-${label}-${suffix}`,
    consent: `consent-q-${label}-${suffix}`,
    session: `session-q-${label}-${suffix}`,
    alignment: `wa-q-${label}-${suffix}`,
    finding: `tf-q-${label}-${suffix}`,
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
     VALUES ($1, $2, $3, '{}'::jsonb, 'fnv1a32:t', $4, 'guided-recite', 'p', false, 0.0, 'draft',
             ${startedAtSql}, 0, $5, '{}'::jsonb, $6, 'ar')`,
    [ids.session, TENANT, learner.id, model.id, ids.consent, ids.audit],
  );
  await queryJson(
    `INSERT INTO word_alignments
       (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
        model_version_id, audit_event_id, transcript_source)
     VALUES ($1, $2, $3, $4, 'x', 0, 100, 0.9, 'matched', $5, $6, 'client-reported')`,
    [ids.alignment, TENANT, ids.session, word.id, model.id, ids.audit],
  );
  await queryJson(
    `INSERT INTO tajweed_findings
       (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
        source_refs, model_version_id, audit_event_id, analysis_basis)
     VALUES ($1, $2, $3, 'ghunnah', 'practice', $4, 'e', $5, '[]'::jsonb, $6, $7, 'canonical-text')`,
    [ids.finding, TENANT, ids.alignment, confidence, reviewStatus, model.id, ids.audit],
  );
  seeded.push(ids);
  return ids.finding;
}

/**
 * Remove exactly what this file seeded — by id, never by pattern, and in FK-safe order.
 *
 * Deletes only rows this process created. Seeds left behind by earlier runs stay: the assertions
 * above are written to tolerate them, and a test that quietly deletes rows it did not create is a
 * worse thing to have in a suite than a slow leak.
 */
after(async () => {
  for (const ids of seeded.reverse()) {
    await queryJson("DELETE FROM tajweed_findings WHERE id = $1", [ids.finding]);
    await queryJson("DELETE FROM word_alignments WHERE id = $1", [ids.alignment]);
    await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [ids.session]);
    await queryJson("DELETE FROM consent_records WHERE id = $1", [ids.consent]);
    await queryJson("DELETE FROM audit_events WHERE id = $1", [ids.audit]);
  }
});

test("a decided finding never outranks one still awaiting review", async () => {
  // The ordering rule, stated as the smallest case that can distinguish it — and deliberately NOT as
  // a claim about how deep the corpus is.
  //
  //   decided   HIGH confidence (0.95), OLD session   -> would come first under `confidence DESC`
  //   awaiting  ZERO confidence,        NEWER session -> must come first under the queue's own rule
  //
  // Both are seeded at the very front of the age ordering so neither depends on the backlog: on a
  // fresh database and on one holding 1986 awaiting findings, the relative order is the same claim.
  const decided = await seedQueued({
    label: "decided",
    reviewStatus: "teacher-reviewed",
    confidence: 0.95,
    startedAtSql: "now() - interval '20 years'",
  });
  const awaiting = await seedQueued({
    label: "awaiting",
    reviewStatus: "teacher-review-required",
    confidence: 0,
    startedAtSql: "now() - interval '19 years'",
  });

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    assert.equal(res.status, 200, `${impl}: ${res.text}`);
    const ids = res.body.map((f) => f.id);

    assert.ok(
      ids.includes(awaiting),
      `${impl}: a finding awaiting review, older than almost everything, is not in the queue at all`,
    );
    const awaitingAt = ids.indexOf(awaiting);
    const decidedAt = ids.indexOf(decided);
    assert.ok(
      decidedAt === -1 || awaitingAt < decidedAt,
      `${impl}: an already-reviewed finding (confidence 0.95) is ahead of one still awaiting ` +
        `review (confidence 0) at positions ${decidedAt} and ${awaitingAt}. The queue is ranking ` +
        "by a number instead of by whether work is needed.",
    );
  }
});

test("zero confidence does not change a finding's place in the queue", async () => {
  // The regression ADR-0036 introduced, isolated: two findings awaiting review, same age ordering,
  // differing ONLY in confidence. Under `confidence DESC` the 0.9 one leads; under the queue's own
  // rule the older one does, whatever its confidence.
  const older = await seedQueued({
    label: "zero",
    reviewStatus: "ai-suggested",
    confidence: 0,
    startedAtSql: "now() - interval '18 years'",
  });
  const newer = await seedQueued({
    label: "high",
    reviewStatus: "ai-suggested",
    confidence: 0.9,
    startedAtSql: "now() - interval '17 years'",
  });

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    // WALK the queue rather than assuming both land on page one. The property under test is the
    // ORDER of these two findings, which is independent of how deep the corpus is; requiring them in
    // the first 200 made the test fail as soon as `seedQueued`'s own leavings crossed that line.
    const ids = [];
    for (let offset = 0; offset < 5_000; offset += 200) {
      const page = await request(base, `/v1/tajweed-findings?offset=${offset}`, { role: "teacher" });
      assert.equal(page.status, 200, `${impl}: offset ${offset}: ${page.text}`);
      ids.push(...page.body.map((f) => f.id));
      if (page.body.length === 0) break;
      if (ids.includes(older) && ids.includes(newer)) break;
    }
    assert.ok(ids.includes(older), `${impl}: the zero-confidence finding is missing from the queue`);
    assert.ok(ids.includes(newer), `${impl}: the high-confidence finding is missing from the queue`);
    assert.ok(
      ids.indexOf(older) < ids.indexOf(newer),
      `${impl}: the newer high-confidence finding leads the older zero-confidence one. Every ` +
        "canonical-text finding now carries confidence 0 (ADR-0036), so this ordering would put all " +
        "new evidence permanently last.",
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

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
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

// ── The queue was traversable only to its first page ──────────────────────────────────────────────
//
// `LIMIT 200` with no offset means a queue deeper than 200 has findings NO teacher can reach,
// whatever the order. Reordering (the previous iteration) changed WHO was unreachable — from
// "everything that needs review" to "the most recent arrivals" — it did not remove the cap.
// Measured: 1986 findings awaiting review, 200 reachable, and nothing on the wire said so.
//
// `offset` makes the rest reachable; `x-total-awaiting` makes the depth visible without changing the
// response from an array to an object, which would break every existing client. Both implementations
// must agree, and the A/B compares headers, so the count is parity-checked too.

test("the queue is traversable past its first page", async () => {
  const [{ awaiting }] = await queryJson(
    `SELECT count(*)::int AS awaiting FROM tajweed_findings
     WHERE tenant_id = $1 AND review_status NOT IN ('teacher-reviewed','blocked','scholar-approved')`,
    [TENANT],
  );
  if (awaiting <= 200) {
    assert.ok(true, `SKIP — only ${awaiting} findings await review, so there is no second page here`);
    return;
  }

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    const page1 = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    const page2 = await request(base, "/v1/tajweed-findings?offset=200", { role: "teacher" });
    assert.equal(page1.status, 200, `${impl}: ${page1.text}`);
    assert.equal(page2.status, 200, `${impl}: ${page2.text}`);

    assert.ok(page2.body.length > 0, `${impl}: offset=200 returned nothing; the queue is still capped`);
    const first = new Set(page1.body.map((f) => f.id));
    const overlap = page2.body.filter((f) => first.has(f.id));
    assert.deepEqual(
      overlap.map((f) => f.id),
      [],
      `${impl}: page 2 repeats ${overlap.length} finding(s) from page 1 — a teacher would review the ` +
        "same work twice and still never reach the end",
    );
  }
});

test("the queue says how deep it is, so truncation is not silent", async () => {
  const [{ awaiting }] = await queryJson(
    `SELECT count(*)::int AS awaiting FROM tajweed_findings
     WHERE tenant_id = $1 AND review_status NOT IN ('teacher-reviewed','blocked','scholar-approved')`,
    [TENANT],
  );

  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    const res = await request(base, "/v1/tajweed-findings", { role: "teacher" });
    const total = res.headers.get("x-total-awaiting");
    assert.ok(total !== null, `${impl}: no x-total-awaiting header — the page size still hides the depth`);
    assert.equal(
      Number(total),
      awaiting,
      `${impl}: the header says ${total} awaiting; the database says ${awaiting}`,
    );
  }
});

test("a hostile offset is refused, not coerced into something", async () => {
  // `offset` reaches SQL. A string, a negative, or a float must be a clean refusal rather than a
  // value the driver decides how to interpret.
  for (const [impl, base] of [["shell", shell.baseUrl], ["rust", rustUrl]]) {
    // The last three are the ones that DISTINGUISH a strict parse from `Number()`. A mutation
    // replacing the digits-only test with a bare `Number(rawOffset)` ran GREEN against the first
    // five, because `Number.isSafeInteger` already rejects NaN, negatives, fractions and Infinity.
    // `Number("0x10")` is 16, `Number(" 5 ")` is 5 and `Number("+5")` is 5 — all silently accepted,
    // none of them something a caller should be able to write. Rust's `parse::<i64>()` refuses all
    // three, so without these the two implementations could drift apart unnoticed.
    for (const bad of [
      "abc",
      "-1",
      "1.5",
      "1e9999",
      "'; DROP TABLE tajweed_findings; --",
      "0x10",
      " 5 ",
      "+5",
    ]) {
      const res = await request(base, `/v1/tajweed-findings?offset=${encodeURIComponent(bad)}`, {
        role: "teacher",
      });
      assert.ok(
        res.status === 400 || res.status === 422,
        `${impl}: offset=${JSON.stringify(bad)} answered ${res.status}, not a refusal`,
      );
    }
  }
});

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
    "confidence",
    "explanation",
    "id",
    "reviewStatus",
    "rule",
    "severity",
    "sources",
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
    "auditEventId",
  ]);
  assert.notEqual(res.body.teacherId, "definitely-not-me");

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

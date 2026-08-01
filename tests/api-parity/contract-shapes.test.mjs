import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertMatchesContract } from "./lib/contract.mjs";
import { queryJson, request, startApi, startMockUpstream, uniqueSuffix } from "./lib/harness.mjs";

/**
 * C3 — the seven operations that had a parity test but NO validated response schema.
 * specs/contract-coverage-closure/plan.md §5
 *
 * The existing coverage for these asserts status codes and authorization; almost none of it asserts
 * a response SHAPE. So their schemas were written from responses observed against a running server,
 * and this file is what keeps observing them — otherwise the schema is a claim nothing rechecks,
 * and `scripts/validate-openapi-responses.mjs` only covers the 26 recorded fixture steps, none of
 * which touch these paths.
 *
 * Every test here asserts the SUCCESS path only. The failure paths already have coverage elsewhere;
 * duplicating it would add runtime without adding an oracle.
 */

let api;
let ml;

before(async () => {
  // privacy/delete calls the ML service to erase audio blobs. Without a mock it 502s, so the
  // success shape is unreachable — which is exactly why this route had no shape evidence.
  ml = await startMockUpstream(() => ({
    status: 200,
    body: { deletedAudioObjectKeys: [], deletedMetadataObjectKeys: [] },
  }));
  api = await startApi({ env: { ML_INFERENCE_URL: ml.url } });
});
after(async () => {
  await api?.stop();
  await ml?.stop();
});

/** A session owned by learner-1, chosen by OWNER rather than recency so parallel suites cannot move it. */
async function learnerSession() {
  const [session] = await queryJson(
    `SELECT id FROM recitation_sessions
     WHERE learner_id = 'learner-1' AND tenant_id = $1
     ORDER BY started_at DESC LIMIT 1`,
    ["hikmah-pilot-erbil"],
  );
  assert.ok(session, "a recitation session owned by learner-1 is required");
  return session.id;
}

test("POST /v1/auth/register matches RegisterResult", async () => {
  const res = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: "hikmah-pilot-erbil",
      displayName: "Contract shape probe",
      role: "learner",
      language: "ar",
      email: `contract-${uniqueSuffix()}@example.test`,
      password: "contract-probe-password-12345",
    },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/auth/register", res);
  // Registration hands back a usable token — a client that had to log in again afterwards would be
  // a different contract, and this is the assertion that would notice.
  assert.ok(res.body.token.length > 0);
  assert.equal(res.body.role, "learner");
});

test("GET /v1/recitation-sessions/{id}/alignments matches WordAlignment[]", async () => {
  // A session with ACTUAL alignments — an empty array satisfies any item schema, so seeding matters
  // here in a way it does not for the other reads.
  const [withRows] = await queryJson(
    "SELECT session_id, count(*)::int AS n FROM word_alignments GROUP BY session_id ORDER BY n DESC LIMIT 1",
  );
  assert.ok(withRows, "a session with persisted word alignments is required");

  const path = `/v1/recitation-sessions/${withRows.session_id}/alignments`;
  const res = await request(api.baseUrl, path, { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "this test is vacuous against an empty array");
  assertMatchesContract("GET", path, res);
});

test("POST /v1/recitation-sessions/{id}/alignments matches PersistAlignmentsResult", async () => {
  const sessionId = await learnerSession();
  const path = `/v1/recitation-sessions/${sessionId}/alignments`;
  const res = await request(api.baseUrl, path, {
    method: "POST",
    role: "learner",
    body: {
      alignments: [
        { wordId: "1:1:1", status: "matched", confidence: 0.9, startMs: 0, endMs: 100, heardText: "a", canonicalText: "b" },
        // Deliberately not a canonical word id — proves skippedUnknownWord is populated rather than
        // always zero, which a happy-path-only body would never show.
        { wordId: "extra-1", status: "matched", confidence: 0.5, startMs: 100, endMs: 200, heardText: "c", canonicalText: "d" },
      ],
    },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", path, res);
  assert.equal(res.body.persisted, 1);
  assert.equal(res.body.skippedUnknownWord, 1, "a non-canonical word id must be skipped and COUNTED");
});

test("POST /v1/recitation-sessions/{id}/request-teacher-review matches both of its shapes", async () => {
  // The response differs by branch: the first request carries auditEventId, a repeat carries
  // alreadyRequested. Both are exercised so the schema is checked against each, not just whichever
  // the seeded state happens to produce.
  const sessionId = await learnerSession();
  const path = `/v1/recitation-sessions/${sessionId}/request-teacher-review`;

  const first = await request(api.baseUrl, path, { method: "POST", role: "learner", body: {} });
  assert.equal(first.status, 200);
  assertMatchesContract("POST", path, first);

  const repeat = await request(api.baseUrl, path, { method: "POST", role: "learner", body: {} });
  assert.equal(repeat.status, 200);
  assertMatchesContract("POST", path, repeat);
  assert.equal(repeat.body.alreadyRequested, true, "a repeat must say so rather than re-requesting");
  assert.equal(repeat.body.reviewStatus, "teacher-review-required");
});

test("POST /v1/learner/progress matches ProgressUpdateResult", async () => {
  const res = await request(api.baseUrl, "/v1/learner/progress", {
    method: "POST",
    role: "learner",
    body: { quality: 4, ayahRef: "1:1" },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/learner/progress", res);
  assert.ok(res.body.sm2State.intervalDays <= 3650, "the interval cap is what stops a chrono overflow panic");
});

test("POST /v1/learner/progress CLAMPS an out-of-range quality rather than failing", async () => {
  // The summary line in the contract claims this. Nothing asserted it, so it was documentation.
  const res = await request(api.baseUrl, "/v1/learner/progress", {
    method: "POST",
    role: "learner",
    body: { quality: 99, ayahRef: "1:2" },
  });
  assert.equal(res.status, 200, "an out-of-range quality is clamped, not a 500");
  assertMatchesContract("POST", "/v1/learner/progress", res);
  assert.ok(res.body.quality <= 5, `quality must be clamped into range, got ${res.body.quality}`);
});

test("GET /v1/agent-runs matches AgentRun[], including a run that HAS sources", async () => {
  // SEEDS its own sourced run rather than hoping one exists. The first version asserted that some
  // ambient row had sources — true on the machine this was written on, false on a fresh CI database,
  // and CI is where it failed. A test whose oracle depends on what other suites happened to leave
  // behind is not an oracle.
  const created = await request(api.baseUrl, "/v1/agent-runs", {
    method: "POST",
    role: "ops",
    body: {
      name: `contract-shape-${uniqueSuffix()}`,
      goal: "exercise the AgentRunSource item schema",
      status: "needs-human-review",
      confidence: 0.5,
      reviewStatus: "ai-suggested",
      sources: [{ id: "s1", title: "Tajweed rule", citation: "ref", url: null }],
    },
  });
  assert.equal(created.status, 200, `seeding a sourced agent run failed: ${created.text}`);

  const res = await request(api.baseUrl, "/v1/agent-runs", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "this test is vacuous against an empty array");
  assertMatchesContract("GET", "/v1/agent-runs", res);

  // `sources` is caller-supplied JSON the server returns verbatim (agent.rs:22), so the contract
  // constrains the ARRAY and not its elements. What is worth asserting is that a source round-trips
  // unchanged — that is the actual guarantee, and the thing a client depends on.
  const mine = res.body.find((run) => run.id === created.body.id);
  assert.ok(mine, "the run seeded above must appear in the listing");
  assert.deepEqual(
    mine.sources,
    [{ id: "s1", title: "Tajweed rule", citation: "ref", url: null }],
    "sources must round-trip verbatim — the server stores them as opaque JSON and normalises nothing",
  );
});

test("POST /v1/privacy/delete matches PrivacyJob", async () => {
  // Erases a learner created FOR this test, through the public registration path. Nothing seeded is
  // touched — a delete against a shared fixture learner would corrupt every other suite's data.
  const suffix = uniqueSuffix();
  const created = await request(api.baseUrl, "/v1/auth/register", {
    method: "POST",
    role: "admin",
    body: {
      tenantId: "hikmah-pilot-erbil",
      displayName: "Erasure shape probe",
      role: "learner",
      language: "ar",
      email: `erasure-${suffix}@example.test`,
      password: "contract-probe-password-12345",
    },
  });
  assert.equal(created.status, 200);

  const res = await request(api.baseUrl, "/v1/privacy/delete", {
    method: "POST",
    role: "admin",
    body: { learnerId: created.body.userId },
  });
  assert.equal(res.status, 200);
  assertMatchesContract("POST", "/v1/privacy/delete", res);
  assert.equal(res.body.kind, "delete");
  assert.equal(res.body.learnerId, created.body.userId);
});

/**
 * N18 — `POST /v1/agent-runs`: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of handlers/agent.rs `create_agent_run`
 *
 *   NODE_API_PORTED="POST /v1/agent-runs" node --test tests/api-parity/agent-write-parity.test.mjs
 *
 * ── The gate this route exists to hold ──────────────────────────────────────────────────────────
 * `status: "approved"` is a claim that this run's output may reach a LEARNER directly. There is no
 * separate human-approval endpoint for agent runs — unlike teacher_reviews and scholar_approvals,
 * this POST is the ONLY place status is ever set. So the server re-derives every condition of
 * `canShowLearnerFacingAiOutput` rather than trusting a client-computed "approved": a reviewed
 * status, confidence >= 0.82, and at least one source. All three, independently.
 *
 * Every refusal below is checked against the DATABASE as well as the response — a handler that
 * inserted the row and then failed would still answer 400 while leaving an approved run behind.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertABMutating } from "./lib/ab.mjs";
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
let learnerId;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl });
  const [l] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  learnerId = l.id;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const source = () => ({ id: "s1", url: null, title: "Tajweed rule", citation: "ref" });

const runBody = (overrides = {}) => ({
  name: "mistake-pattern",
  goal: "find repeated errors",
  status: "needs-human-review",
  confidence: 0.5,
  reviewStatus: "ai-suggested",
  sources: [source()],
  lastEvent: "started",
  ...overrides,
});

const norm = (b) =>
  b && typeof b === "object" && b.id ? { ...b, id: "<ID>" } : b;

const countRuns = async () => {
  const [r] = await queryJson(
    "SELECT COUNT(*)::int AS n FROM agent_runs WHERE tenant_id = $1 AND status = 'approved'",
    [TENANT],
  );
  return r.n;
};

test("recording a run returns the alphabetical shape — and NOT the list route's shape", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "create agent run",
    probeFor: () => ({ path: "/v1/agent-runs", method: "POST", role: "admin", body: runBody() }),
    normalize: norm,
  });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(Object.keys(s.body), [
    "confidence",
    "goal",
    "id",
    "lastEvent",
    "learnerId",
    "name",
    "reviewStatus",
    "sources",
    "status",
  ], "no findingId and no auditEventId here — the LIST route has findingId, this one does not");
});

test("recording is scholar/admin/ops — every other role is refused identically", async () => {
  for (const role of ["learner", "teacher", "scholar", "admin", "ops"]) {
    await assertABMutating(shell.baseUrl, rustUrl, {
      name: `create agent run as ${role}`,
      probeFor: () => ({ path: "/v1/agent-runs", method: "POST", role, body: runBody() }),
      normalize: norm,
    });
  }
});

// ── the approval gate ──────────────────────────────────────────────────────────────────────────

test("approved requires ALL THREE conditions — each one alone is refused", async () => {
  const before = await countRuns();

  const cases = [
    // reviewStatus not reviewed, everything else fine
    { reviewStatus: "ai-suggested", confidence: 0.99, sources: [source()] },
    // confidence just below the threshold
    { reviewStatus: "scholar-approved", confidence: 0.81, sources: [source()] },
    // no sources
    { reviewStatus: "scholar-approved", confidence: 0.99, sources: [] },
    // nothing satisfied
    { reviewStatus: "draft", confidence: 0, sources: [] },
  ];

  for (const c of cases) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `approved with ${JSON.stringify(c)}`,
      probeFor: () => ({
        path: "/v1/agent-runs",
        method: "POST",
        role: "admin",
        body: runBody({ status: "approved", ...c }),
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 400, `${JSON.stringify(c)} must not be approvable`);
    assert.match(s.body.error, /confidence >= 0\.82/);
  }

  assert.equal(
    await countRuns(),
    before,
    "a refused approval must leave NO approved run behind — a 400 after an insert is still a row",
  );
});

test("0.82 exactly is ALLOWED — the boundary is >=, not >", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "approved at exactly 0.82",
    probeFor: () => ({
      path: "/v1/agent-runs",
      method: "POST",
      role: "admin",
      body: runBody({ status: "approved", reviewStatus: "scholar-approved", confidence: 0.82 }),
    }),
    normalize: norm,
  });
  assert.equal(s.status, 200, s.text);
});

test("BOTH reviewed statuses satisfy the gate", async () => {
  for (const reviewStatus of ["teacher-reviewed", "scholar-approved"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `approved via ${reviewStatus}`,
      probeFor: () => ({
        path: "/v1/agent-runs",
        method: "POST",
        role: "admin",
        body: runBody({ status: "approved", reviewStatus, confidence: 0.9 }),
      }),
      normalize: norm,
    });
    assert.equal(s.status, 200, `${reviewStatus} must satisfy the gate: ${s.text}`);
  }
});

test("the gate applies ONLY to approved — every other status is unaffected", async () => {
  for (const status of ["queued", "running", "needs-human-review", "blocked"]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `${status} with nothing satisfied`,
      probeFor: () => ({
        path: "/v1/agent-runs",
        method: "POST",
        role: "admin",
        body: runBody({ status, reviewStatus: "draft", confidence: 0, sources: [] }),
      }),
      normalize: norm,
    });
    assert.equal(s.status, 200, `${status} is not an approval and must not be gated: ${s.text}`);
  }
});

// ── validation ─────────────────────────────────────────────────────────────────────────────────

test("an invalid status or reviewStatus is a clean 400, not an opaque 500 from the CHECK", async () => {
  for (const [field, value] of [
    ["status", "definitely-not-a-status"],
    ["reviewStatus", "definitely-not-a-review-status"],
  ]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `${field} = ${value}`,
      probeFor: () => ({
        path: "/v1/agent-runs",
        method: "POST",
        role: "admin",
        body: runBody({ [field]: value }),
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 400);
    assert.match(s.body.error, new RegExp(value), "the message must name the offending value");
  }
});

test("confidence outside [0,1] is 400", async () => {
  for (const confidence of [-0.1, 1.1, 99]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
      name: `confidence ${confidence}`,
      probeFor: () => ({
        path: "/v1/agent-runs",
        method: "POST",
        role: "admin",
        body: runBody({ confidence }),
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 400);
    assert.equal(s.body.error, "confidence must be within [0, 1]");
  }
});

test("learnerId is checked ONLY when present — absent is legitimate", async () => {
  // A learner-less run is normal: the mistake-pattern and practice-plan agents both write them.
  // Firing on absent-vs-unknown would break the agents service silently.
  const { shell: absent } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "run with no learnerId",
    probeFor: () => ({ path: "/v1/agent-runs", method: "POST", role: "admin", body: runBody() }),
    normalize: norm,
  });
  assert.equal(absent.status, 200, absent.text);
  assert.equal(absent.body.learnerId, null);

  const { shell: known } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "run with a real learnerId",
    probeFor: () => ({
      path: "/v1/agent-runs",
      method: "POST",
      role: "admin",
      body: runBody({ learnerId }),
    }),
    normalize: norm,
  });
  assert.equal(known.status, 200, known.text);

  const { shell: unknown } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "run with an unknown learnerId",
    probeFor: () => ({
      path: "/v1/agent-runs",
      method: "POST",
      role: "admin",
      body: runBody({ learnerId: "learner-does-not-exist" }),
    }),
    normalize: (b) => b,
  });
  assert.equal(unknown.status, 404, "a dangling FK must be a 404, not an opaque 500");
});

/**
 * The BTreeMap rule, on a path that never touches Postgres.
 *
 * The response ECHOES `req.sources`. But by the time Rust echoes it, serde has already parsed the
 * request body into a `serde_json::Value` — which without `preserve_order` is a BTreeMap — so the
 * sources come back with their keys ALPHABETIZED even though they were never near the database.
 * Node's parser preserves the client's order, so the same normalization the N11 READ route needed
 * applies here too. Deliberately sent in a NON-alphabetical order so the test can tell.
 */
test("echoed sources come back with keys alphabetized, though they never reach the database",
  async () => {
    const res = await request(shell.baseUrl, "/v1/agent-runs", {
      method: "POST",
      role: "admin",
      body: runBody({ sources: [{ url: null, title: "T", id: "s1", citation: "c" }] }),
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      Object.keys(res.body.sources[0]),
      ["citation", "id", "title", "url"],
      "sent as url,title,id,citation — serde_json's BTreeMap returns them sorted",
    );
  });

test("lastEvent defaults to the empty string, not null", async () => {
  const body = runBody();
  delete body.lastEvent;
  const { shell: s } = await assertABMutating(shell.baseUrl, rustUrl, {
    name: "run with no lastEvent",
    probeFor: () => ({ path: "/v1/agent-runs", method: "POST", role: "admin", body }),
    normalize: norm,
  });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.body.lastEvent, "", "a null would vanish in a client that treats null as absent");
});

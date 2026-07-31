import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// F3 coverage — specs/api-golden-fixtures/plan.md
//
// A baseline of happy paths lets a port get every failure mode wrong while passing, so the failure
// cases are asserted mechanically rather than left to reviewer diligence.
//
// This file also records what is NOT covered. A coverage test that only asserts what exists reads
// as completeness; naming the gaps is what stops the fixture set being over-trusted.

const fixture = JSON.parse(
  readFileSync("specs/api-golden-fixtures/fixtures/platform-api.json", "utf8"),
);

const statuses = fixture.steps.map((s) => s.response.status);
const has = (code) => statuses.includes(code);

test("the fixture set is non-trivial", () => {
  assert.ok(fixture.steps.length >= 20, `only ${fixture.steps.length} steps`);
  assert.equal(fixture.stepCount, fixture.steps.length, "stepCount must match the actual steps");
});

test("failure cases are a substantial share, not an afterthought", () => {
  const failures = statuses.filter((s) => s >= 400).length;
  assert.ok(
    failures >= 8,
    `only ${failures} failure cases — a happy-path baseline lets a port get every error wrong`,
  );
});

test("every client-facing ApiError status is represented", () => {
  // types.rs:375 maps: Unauthorized->401, Forbidden->403, NotFound->404,
  // MissingSources/HighRiskApproval/BadRequest->400.
  for (const code of [400, 401, 403, 404]) {
    assert.ok(has(code), `no fixture exercises HTTP ${code}`);
  }
});

test("KNOWN GAP: 5xx ApiError variants are not covered, and that is recorded here", () => {
  // ApiError::Database (500) and ApiError::UpstreamUnavailable (502/503) cannot be triggered from a
  // clean scenario without deliberately breaking the database or an upstream service. They are
  // therefore NOT in the fixture set.
  //
  // This test asserts the gap rather than hiding it: if someone later adds 5xx coverage, this fails
  // and they update the record. That is the intended behaviour — a coverage claim should go stale
  // loudly.
  assert.ok(
    !has(500) && !has(502) && !has(503),
    "a 5xx fixture now exists — update this test and the fixture README: the gap is closed",
  );
});

test("the deliberate 404-not-401 on /metrics is captured", () => {
  // Hides the endpoint's existence. A port that "fixes" this to 401 leaks that it is there.
  const step = fixture.steps.find((s) => s.request.path === "/metrics");
  assert.ok(step, "no /metrics fixture");
  assert.equal(step.response.status, 404, "/metrics must 404, not 401, on a bad token");
});

test("the snake_case /v1/auth/token body is captured with its casing intact", () => {
  const step = fixture.steps.find(
    (s) => s.request.path === "/v1/auth/token" && s.response.status === 200,
  );
  assert.ok(step, "no successful /v1/auth/token fixture");
  const keys = Object.keys(step.response.body);
  for (const k of ["user_id", "tenant_id", "audit_event_id"]) {
    assert.ok(keys.includes(k), `${k} missing — the snake_case contract is not captured`);
  }
  assert.ok(!keys.includes("userId"), "camelCase key present — the capture normalized casing");
});

test("no SERVER-RETURNED secret or unstable id survives in the fixture", () => {
  // Scoped to RESPONSES deliberately. The hazard is a value the SERVER produced being committed —
  // a leaked token, or an id that changes every run and makes the fixture flaky. Request bodies
  // hold constants this scenario authored (e.g. the all-zeros "unknown token" probe); those are
  // inputs, not leaks, and normalizing them would destroy the very case they test.
  const responses = JSON.stringify(fixture.steps.map((s) => s.response));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(responses), "a JWT appears verbatim in a response");
  assert.ok(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(responses),
    "a raw UUID survived in a response — normalization missed it, and the fixture will be flaky",
  );
});

test("only seeded synthetic learners appear — no real learner data is committed", () => {
  const raw = JSON.stringify(fixture);
  const learnerIds = [...raw.matchAll(/"learnerId":\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const id of new Set(learnerIds)) {
    assert.match(id, /^learner-\d+$/, `non-synthetic learner id in fixture: ${id}`);
  }
});

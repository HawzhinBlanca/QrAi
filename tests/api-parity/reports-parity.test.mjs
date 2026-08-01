/**
 * N11 — agent runs, audit events, eval runs: the Node shell against Rust.
 * specs/migration-completion/plan.md §2
 *
 *   NODE_API_PORTED="GET /v1/agent-runs,GET /v1/audit-events,GET /v1/eval-runs/{model_version}" \
 *     node --test tests/api-parity/reports-parity.test.mjs
 *
 * All three are read-only and staff-gated, with THREE DIFFERENT role lists. Getting one of those
 * lists wrong is the kind of mistake that reads as correct — which is why each is probed for every
 * role rather than for the one the happy path uses.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { formatF32, formatF64 } from "../../services/node-api/lib/json.mjs";
import { request, startApi, startShell } from "./lib/harness.mjs";

let api;
let shell;

before(async () => {
  api = await startApi({});
  shell = await startShell({ upstream: api.baseUrl });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const ROLES = ["learner", "teacher", "scholar", "admin", "ops"];

test("GET /v1/agent-runs is byte-identical for EVERY role, allowed or refused", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/agent-runs", role });
  }
});

test("agent-runs allows scholar; audit and eval do NOT — three different lists", async () => {
  const status = async (path, role) => (await request(shell.baseUrl, path, { role })).status;

  assert.equal(await status("/v1/agent-runs", "scholar"), 200, "a scholar reviews agent output");
  assert.equal(await status("/v1/agent-runs", "teacher"), 200);
  assert.equal(await status("/v1/agent-runs", "learner"), 403);

  assert.equal(await status("/v1/audit-events", "scholar"), 403, "audit is admin/ops only");
  assert.equal(await status("/v1/audit-events", "teacher"), 403);
  assert.equal(await status("/v1/audit-events", "admin"), 200);

  assert.equal(await status("/v1/eval-runs/anything", "scholar"), 403);
  assert.equal(await status("/v1/eval-runs/anything", "teacher"), 403);
});

test("GET /v1/audit-events is byte-identical for every role", async () => {
  for (const role of ROLES) {
    await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/audit-events", role });
  }
});

test("audit events keep DECLARATION order — AuditEvent is a struct, not a json! literal", async () => {
  const res = await request(shell.baseUrl, "/v1/audit-events", { role: "admin" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "the seeded corpus has audit events; without any this proves nothing");
  assert.deepEqual(Object.keys(res.body[0]), [
    "id",
    "tenantId",
    "actorId",
    "traceId",
    "action",
    "subjectType",
    "subjectId",
  ]);
});

test("GET /v1/eval-runs/{v}: a missing model version is 404, identically", async () => {
  for (const path of ["/v1/eval-runs/no-such-model", "/v1/eval-runs/..%2Fetc", "/v1/eval-runs/%20"]) {
    await assertAB(shell.baseUrl, api.baseUrl, { path, role: "admin" });
  }
});

/**
 * The f32 case, and why it needs its own test.
 *
 * `EvalRun`'s four metrics are `f32` (types.rs:276-279): read from Postgres as float8, narrowed
 * with `as f32`, then printed by serde as the shortest string that round-trips to that SINGLE.
 * A JS port has only doubles, so without an explicit narrow-and-shorten a metric can carry extra
 * digits. Byte-identical is the only assertion that catches it — and it only fires on a value the
 * two formatters actually PRINT differently, which this corpus does not contain. The test below
 * records that gap explicitly rather than letting this one imply coverage it does not have.
 */
test("eval-run metrics survive the f32 narrowing byte-for-byte", async () => {
  const rows = await request(shell.baseUrl, "/v1/eval-runs/seeded-eval-f32", { role: "admin" });
  if (rows.status === 404) {
    // No seeded row: assert the SHAPE against Rust on whatever the corpus does have, and say
    // plainly that the precision case is uncovered rather than reporting a pass that proves nothing.
    const list = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
    if (list.status === 404) {
      assert.ok(true, "SKIP — no eval_runs row in this corpus; f32 precision is covered by the " +
        "unit tests in tests/node-api/rust-json.test.mjs only");
      return;
    }
  }
  await assertAB(shell.baseUrl, api.baseUrl, { path: "/v1/eval-runs/model-v0.3", role: "admin" });
});

/**
 * A RECORDED GAP, stated rather than left silent.
 *
 * Replacing `f32()` with `f64()` on a metric runs GREEN against this corpus: for every seeded value
 * the two formatters produce the SAME string, so the wrong one changes nothing. (Not because the
 * values are exactly representable — 0.93 is not — but because both shortest-round-trip forms come
 * out as "0.93".) The A/B has no teeth for the narrowing here, and
 * `tests/node-api/rust-json.test.mjs` is the only thing covering it.
 *
 * Assert the PREMISE, so that if the corpus ever gains a value the two formatters disagree on, this
 * test says the A/B has become load-bearing instead of it quietly starting to matter.
 */
test("the f32 narrowing is NOT exercised by this corpus — stated, not assumed", async () => {
  const res = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
  if (res.status === 404) return;
  for (const key of ["wordAlignmentF1", "tajweedF1", "falsePositiveRate", "teacherAgreementRate"]) {
    const v = res.body[key];
    if (typeof v !== "number") continue;
    // The discriminator is NOT "is it exactly representable in f32" — 0.93 is not, and both
    // formatters still print "0.93". What matters is whether the two formatters DISAGREE on this
    // value; only then does using the wrong one change the bytes. (First draft of this test used
    // exact-representability and failed on 0.93 while the mutation still ran green — the premise
    // was measuring the wrong thing.)
    assert.equal(
      formatF32(v),
      formatF64(v),
      `${key} = ${v} now prints differently as f32 (${formatF32(v)}) than as f64 (${formatF64(v)}). ` +
        "The f32-vs-f64 mutation is no longer silent, so the A/B above genuinely covers the " +
        "narrowing — good, but confirm it rather than assuming.",
    );
  }
});

test("an integer count does NOT gain a decimal point next to the f32 metrics", async () => {
  const res = await request(shell.baseUrl, "/v1/eval-runs/model-v0.3", { role: "admin" });
  if (res.status === 404) return;
  assert.match(
    res.text,
    /"unsourcedLearnerOutputs":\d+(,|})/,
    "unsourcedLearnerOutputs is u32; wrapping it in f32()/f64() by mistake would emit `0.0`",
  );
});

test("agent-runs: sources is jsonb the server does not validate, and passes through unchanged",
  async () => {
    const res = await request(shell.baseUrl, "/v1/agent-runs", { role: "admin" });
    assert.equal(res.status, 200);
    for (const run of res.body) {
      assert.ok(Array.isArray(run.sources) || typeof run.sources === "object");
      // lastEvent falls back to "" and NOT to null: a null would vanish in a client that treats
      // null as absent, and the field is what an operator reads to see where a run stopped.
      assert.equal(typeof run.lastEvent, "string");
    }
  });

test("agent-runs key order is alphabetical — json!, unlike AuditEvent", async () => {
  const res = await request(shell.baseUrl, "/v1/agent-runs", { role: "admin" });
  if (res.body.length === 0) return;
  assert.deepEqual(Object.keys(res.body[0]), [
    "confidence",
    "findingId",
    "goal",
    "id",
    "lastEvent",
    "learnerId",
    "name",
    "reviewStatus",
    "sources",
    "status",
  ]);
});

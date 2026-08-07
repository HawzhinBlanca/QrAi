/**
 * P5.3 fault test — the Node shell's readiness/liveness split under a database outage.
 *
 * The Rust side is covered by `readiness_reports_503_when_postgres_is_unreachable_while_liveness_holds`
 * (services/platform-api/tests/integration.rs). This is the same contract on the other implementation,
 * and it is NOT redundant: `GET /ready` is in the executable route registry, so during a cutover the
 * Node process is the one an orchestrator asks. A port that answered 200 while its pool was dead would
 * keep traffic flowing to a process where every request fails — and the existing A/B coverage
 * (`infra-parity.test.mjs`) only ever exercises the HAPPY path, `s.text === "ready"`.
 *
 * Why a unit test rather than an A/B parity test: the fault state cannot be produced inside the
 * parity harness. That harness needs a live Postgres for every other test in the same run, so there
 * is no point at which the database can be taken away from one server without destroying the rest of
 * the suite. `ready` is an exported function taking its context explicitly, so the outage can be
 * handed to it directly — deterministic, and no database required in either direction.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { health, ready } from "../../server/src/routes/infra.mjs";

/** Minimal Fastify-shaped reply that records what the handler decided. */
function fakeReply() {
  const captured = { code: null, type: null, body: null };
  const reply = {
    code(value) {
      captured.code = value;
      return reply;
    },
    type(value) {
      captured.type = value;
      return reply;
    },
    send(value) {
      captured.body = value;
      return reply;
    },
    captured,
  };
  return reply;
}

test("readiness is 503 when the shell has no database pool at all", async () => {
  const reply = fakeReply();
  await ready({}, reply, { db: null });
  assert.equal(reply.captured.code, 503, "a shell with no pool reported itself ready to serve");
  assert.equal(reply.captured.body, "not ready");
});

test("readiness is 503 when the pool exists but the query fails", async () => {
  // The realistic outage: the pool object is fine, Postgres is not.
  const reply = fakeReply();
  await ready({}, reply, {
    db: {
      sql() {
        throw new Error("ECONNREFUSED 10.0.0.5:5432");
      },
    },
  });
  assert.equal(
    reply.captured.code,
    503,
    "the query threw and readiness still answered OK — an orchestrator would keep routing traffic here",
  );
  assert.equal(reply.captured.body, "not ready");
});

test("readiness is 200 only when the database actually answers", async () => {
  // The control. Without it, every assertion above is satisfied by a handler hardcoded to 503,
  // which would take the service permanently out of rotation instead of into it.
  const reply = fakeReply();
  let queried = false;
  await ready({}, reply, {
    db: {
      sql() {
        queried = true;
        return Promise.resolve([{ "?column?": 1 }]);
      },
    },
  });
  assert.equal(reply.captured.code, 200);
  assert.equal(reply.captured.body, "ready");
  assert.ok(queried, "readiness returned 200 without asking the database anything");
});

test("the 503 body leaks nothing about why the database is unreachable", async () => {
  // infra.mjs states this deliberately: the reason a database is unreachable is TOPOLOGY, and
  // /ready answers without credentials. A handler that helpfully echoed the driver error would
  // publish an internal host and port to anyone who could reach the endpoint.
  const reply = fakeReply();
  await ready({}, reply, {
    db: {
      sql() {
        throw new Error("ECONNREFUSED 10.0.0.5:5432 password authentication failed for user 'quran_ai_app'");
      },
    },
  });
  const body = String(reply.captured.body);
  for (const leak of ["10.0.0.5", "5432", "ECONNREFUSED", "password", "quran_ai_app"]) {
    assert.ok(
      !body.includes(leak),
      `the readiness failure body leaked ${JSON.stringify(leak)}: ${JSON.stringify(body)}`,
    );
  }
});

test("liveness stays 200 during a database outage, with no pool at all", async () => {
  // The other half of the pair, and the half whose failure is worst: a /health that goes 503
  // during a DB blip tells the orchestrator to kill and reschedule a process that would have
  // recovered on its own. Liveness must not consult the database, so this passes it none.
  const reply = fakeReply();
  await health({}, reply, { db: null });
  assert.equal(
    reply.captured.code,
    200,
    "liveness reported the PROCESS as down because its DATABASE was — that is a restart storm",
  );
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { DATABASE_URL, request, startApi } from "../api-parity/lib/harness.mjs";

/**
 * @fault-coverage: postgres
 *
 * platform-api answers a database outage with a retryable 503, and keeps saying it is ALIVE. (P5.3)
 *
 * `docs/readiness/INVENTORIES.md` publishes this for Postgres: acquire timeout "→ retryable 503",
 * and "`/ready` returns 503 when the pool can't answer (liveness `/health` stays 200) so
 * orchestrators see 'up but can't serve'". That distinction is the whole point — a 503 on `/ready`
 * takes the instance out of the load-balancer rotation; a failing `/health` makes the orchestrator
 * KILL and reschedule it, which during a database outage means every replica crash-looping while
 * the database is the thing that is broken.
 *
 * What was actually tested before this: `integration.rs:257`
 * `ready_endpoint_returns_200_when_the_db_pool_answers` — the healthy case, and only the healthy
 * case. `tests/node-api/readiness-fault.test.mjs` covers the fault thoroughly, but for the **Node
 * port**. So the degraded behavior was proven in the port and unproven in the original: the inverse
 * of the gap this project usually finds, and just as invisible.
 *
 * ── Making a real outage deterministic ──────────────────────────────────────────────────────────
 * `main.rs:187` calls `.connect()` eagerly, so the service cannot boot against a dead database —
 * the outage has to begin AFTER boot. Killing backends on the shared development database would
 * race every other test in the run, and sqlx would transparently reconnect anyway (correctly).
 *
 * So this creates a throwaway database, boots the service against it, proves it healthy, then drops
 * that database `WITH (FORCE)`. Every pooled connection dies and no new one can be made, which is
 * exactly what platform-api sees when Postgres goes away. Nothing else in the run can observe it,
 * because nothing else knows the database exists.
 *
 * Requires a live Postgres and CREATEDB. Neither is optional: a skip here gates nothing.
 */

const suffix = `${process.pid}_${Date.now().toString(36)}`;
const FAULT_DB = `qrai_fault_${suffix}`;

/** Admin connection to the maintenance database, so it survives dropping the target. */
const admin = postgres(new URL("/postgres", DATABASE_URL).toString(), {
  max: 1,
  onnotice: () => {},
});

function faultUrl() {
  return new URL(`/${FAULT_DB}`, DATABASE_URL).toString();
}

let api;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set — this test needs a live Postgres");
  await admin.unsafe(`CREATE DATABASE ${FAULT_DB}`);
  // No migrations: `/health` and `/ready` touch no application table, and boot runs none. An empty
  // database is enough to prove the pool works and, once dropped, that it does not.
  api = await startApi({ env: { DATABASE_URL: faultUrl() } });
});

after(async () => {
  await api?.stop();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${FAULT_DB} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

test("before the outage, the service is both alive and ready", async () => {
  // The baseline is not ceremony. Without it, a 503 below could mean the service never came up, and
  // the test would "pass" while proving nothing about outage behavior.
  const health = await request(api.baseUrl, "/health");
  const ready = await request(api.baseUrl, "/ready");
  assert.equal(health.status, 200, "the service should be alive before the fault");
  assert.equal(ready.status, 200, "the service should be ready before the fault");
});

test("during a real outage, /ready is 503 and /health stays 200", async () => {
  await admin.unsafe(`DROP DATABASE ${FAULT_DB} WITH (FORCE)`);

  const ready = await request(api.baseUrl, "/ready");
  assert.equal(
    ready.status,
    503,
    `/ready must report 503 when the pool cannot answer, got ${ready.status}. ` +
      `A ready instance that cannot reach the database keeps receiving traffic it can only fail.`,
  );

  const health = await request(api.baseUrl, "/health");
  assert.equal(
    health.status,
    200,
    `/health must stay 200 during a database outage, got ${health.status}. ` +
      `A failing liveness probe makes the orchestrator kill and reschedule every replica while the ` +
      `database is the thing that is broken.`,
  );
});

test("the outage response says nothing about the database", async () => {
  // Mirrors the guarantee tests/node-api/readiness-fault.test.mjs makes for the port: an unauthenticated
  // probe response is a fine place to leak a host, a database name, or a role.
  const ready = await request(api.baseUrl, "/ready");
  assert.equal(ready.status, 503);
  const text = String(ready.text).toLowerCase();
  for (const leak of [FAULT_DB.toLowerCase(), "postgres", "password", "5432", "sqlx", "pool"]) {
    assert.ok(
      !text.includes(leak),
      `the /ready failure body leaks ${JSON.stringify(leak)}: ${ready.text}`,
    );
  }
});

test("the outage is still an outage on a second probe, not a one-off", async () => {
  // A single 503 could be one dropped connection. Readiness must stay false for as long as the
  // database is gone, or the instance flaps back into rotation and fails real traffic.
  for (let i = 0; i < 3; i += 1) {
    const ready = await request(api.baseUrl, "/ready");
    assert.equal(ready.status, 503, `probe ${i + 1} should still be 503`);
  }
});

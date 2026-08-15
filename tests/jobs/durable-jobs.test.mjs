import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { createDb } from "../../server/src/lib/db.mjs";
import {
  IdempotencyConflictError,
  JobReplayForbiddenError,
  StaleJobLeaseError,
  createJobStore,
} from "../../server/src/jobs/store.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import {
  createTestDatabase,
  migrationTestAdminUrl,
} from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const TENANT = "hikmah-pilot-erbil";
const ACTOR = "ops-1";

function appConnectionString(connectionString, roleName, password) {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function setup(t) {
  const database = await createTestDatabase(t, "durable_jobs");
  if (!database) return null;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "durable-job-test-password";
  await provisionApplicationRole({ connectionString: database.connectionString, roleName, password });

  const adminUrl = migrationTestAdminUrl();
  t.after(async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop owned by "${roleName}" cascade`);
    await cleanup.query(`drop role if exists "${roleName}"`);
    await cleanup.end();
  });

  const db = createDb(appConnectionString(database.connectionString, roleName, password));
  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  return {
    admin,
    db,
    store: createJobStore({ db }),
    close: async () => {
      await db.end();
      await admin.end();
    },
  };
}

function request(overrides = {}) {
  return {
    tenantId: TENANT,
    kind: "session.finalize",
    subjectId: `session-${randomUUID()}`,
    actorId: ACTOR,
    idempotencyKey: `request-${randomUUID()}`,
    payload: { sessionId: `session-${randomUUID()}` },
    maxAttempts: 3,
    ...overrides,
  };
}

test("durable job store and bounded runtime", async (t) => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { admin, store } = fixture;

  try {

  await t.test("concurrent idempotent enqueue creates one job and one audit", async () => {
    const same = request({
      idempotencyKey: `same-${randomUUID()}`,
      subjectId: "session-idempotent",
      payload: { sessionId: "session-idempotent" },
    });
    const jobs = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(same)));
    assert.equal(new Set(jobs.map(({ id }) => id)).size, 1);

    const rows = await admin.query(
      "select id, audit_event_id from background_jobs where tenant_id = $1 and idempotency_key = $2",
      [TENANT, same.idempotencyKey],
    );
    assert.equal(rows.rows.length, 1);
    const audits = await admin.query(
      "select count(*)::int as count from audit_events where id = $1",
      [rows.rows[0].audit_event_id],
    );
    assert.equal(audits.rows[0].count, 1);

    await assert.rejects(
      () => store.enqueue({ ...same, payload: { sessionId: "different" } }),
      IdempotencyConflictError,
    );
  });

  await t.test("concurrent claims are distinct and carry monotonic lease generations", async () => {
    const one = await store.enqueue(request({ priority: 5 }));
    const two = await store.enqueue(request({ priority: 5 }));
    const [a, b] = await Promise.all([
      store.claim({ tenantId: TENANT, workerId: "worker-a", leaseMs: 2_000 }),
      store.claim({ tenantId: TENANT, workerId: "worker-b", leaseMs: 2_000 }),
    ]);
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(new Set([a.id, b.id]), new Set([one.id, two.id]));
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.equal(a.attemptCount, 1);
    assert.equal(a.leaseGeneration, 1);
  });

  await t.test("an expired lease is reclaimed and the stale generation cannot commit", async () => {
    const queued = await store.enqueue(request({ idempotencyKey: `fence-${randomUUID()}` }));
    const first = await store.claim({
      tenantId: TENANT,
      workerId: "worker-old",
      leaseMs: 2_000,
      jobId: queued.id,
    });
    await admin.query(
      "update background_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [queued.id],
    );
    const second = await store.claim({
      tenantId: TENANT,
      workerId: "worker-new",
      leaseMs: 2_000,
      jobId: queued.id,
    });
    assert.equal(second.leaseGeneration, 2);
    assert.equal(second.attemptCount, 2);

    let staleCommitCalled = false;
    await assert.rejects(
      () => store.complete({
        tenantId: TENANT,
        jobId: first.id,
        workerId: first.leaseOwner,
        leaseGeneration: first.leaseGeneration,
        result: { status: "stale" },
        commit: async () => { staleCommitCalled = true; },
      }),
      StaleJobLeaseError,
    );
    assert.equal(staleCommitCalled, false);

    const effectId = `audit-effect-${randomUUID()}`;
    const completed = await store.complete({
      tenantId: TENANT,
      jobId: second.id,
      workerId: second.leaseOwner,
      leaseGeneration: second.leaseGeneration,
      result: { status: "done" },
      commit: async (tx) => {
        await tx`
          insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
          values (${effectId}, ${TENANT}, ${ACTOR}, 'test.job.effect', 'background_job', ${second.id})`;
      },
    });
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { status: "done" });

    await assert.rejects(
      () => store.complete({
        tenantId: TENANT,
        jobId: second.id,
        workerId: second.leaseOwner,
        leaseGeneration: second.leaseGeneration,
        result: { status: "duplicate" },
        commit: async (tx) => tx`select 1`,
      }),
      StaleJobLeaseError,
    );
    const effects = await admin.query("select count(*)::int as count from audit_events where id = $1", [effectId]);
    assert.equal(effects.rows[0].count, 1);
  });

  await t.test("fixed failures retry with a bound and become observable dead letters", async () => {
    const queued = await store.enqueue(request({ maxAttempts: 2 }));
    const first = await store.claim({
      tenantId: TENANT,
      workerId: "worker-retry",
      leaseMs: 2_000,
      jobId: queued.id,
    });
    const retry = await store.fail({
      tenantId: TENANT,
      jobId: first.id,
      workerId: first.leaseOwner,
      leaseGeneration: first.leaseGeneration,
      errorCode: "dependency_unavailable",
      retryDelayMs: 0,
    });
    assert.equal(retry.status, "retry");
    assert.equal(retry.lastErrorCode, "dependency_unavailable");

    const second = await store.claim({
      tenantId: TENANT,
      workerId: "worker-retry",
      leaseMs: 2_000,
      jobId: queued.id,
    });
    const dead = await store.fail({
      tenantId: TENANT,
      jobId: second.id,
      workerId: second.leaseOwner,
      leaseGeneration: second.leaseGeneration,
      errorCode: "dependency_unavailable",
      retryDelayMs: 0,
    });
    assert.equal(dead.status, "dead");
    assert.ok(dead.deadAt);

    await assert.rejects(
      () => store.fail({
        tenantId: TENANT,
        jobId: dead.id,
        workerId: "worker-retry",
        leaseGeneration: dead.leaseGeneration,
        errorCode: "https://secret.invalid/raw error",
        retryDelayMs: 0,
      }),
      /errorCode/,
    );

    const summary = await store.summary({ tenantId: TENANT });
    assert.ok(summary.dead >= 1);
    assert.ok(summary.running >= 2);
  });

  await t.test("an authorized operator replays a dead letter as a new immutable job", async () => {
    const queued = await store.enqueue(request({
      subjectId: "session-replay",
      payload: { sessionId: "session-replay" },
      maxAttempts: 1,
    }));
    const claimed = await store.claim({
      tenantId: TENANT,
      workerId: "worker-dead-letter",
      leaseMs: 2_000,
      jobId: queued.id,
    });
    const dead = await store.fail({
      tenantId: TENANT,
      jobId: claimed.id,
      workerId: claimed.leaseOwner,
      leaseGeneration: claimed.leaseGeneration,
      errorCode: "dependency_unavailable",
      retryDelayMs: 0,
    });

    await assert.rejects(
      () => store.requeueDead({ tenantId: TENANT, jobId: dead.id, operatorId: "learner-1" }),
      JobReplayForbiddenError,
    );

    const replay = await store.requeueDead({
      tenantId: TENANT,
      jobId: dead.id,
      operatorId: ACTOR,
    });
    assert.notEqual(replay.id, dead.id);
    assert.equal(replay.status, "queued");
    assert.equal(replay.attemptCount, 0);
    assert.equal(replay.leaseGeneration, 0);
    assert.equal(replay.subjectId, dead.subjectId);
    assert.equal(replay.actorId, dead.actorId);
    assert.deepEqual(replay.payload, dead.payload);
    assert.equal(replay.idempotencyKey, `replay:${dead.id}`);

    const original = await store.get({ tenantId: TENANT, jobId: dead.id });
    assert.equal(original.status, "dead");
    assert.equal(original.attemptCount, original.maxAttempts);
    assert.equal(original.lastErrorCode, "dependency_unavailable");

    const audit = await admin.query(
      `select actor_id, action, subject_id, metadata
         from audit_events where id = $1`,
      [replay.auditEventId],
    );
    assert.deepEqual(audit.rows, [{
      actor_id: ACTOR,
      action: "job.session.finalize.requeued",
      subject_id: replay.id,
      metadata: { kind: "session.finalize", sourceJobId: dead.id },
    }]);

    const repeated = await store.requeueDead({
      tenantId: TENANT,
      jobId: dead.id,
      operatorId: ACTOR,
    });
    assert.equal(repeated.id, replay.id, "the same dead row created more than one successor");
    const replayAudits = await admin.query(
      `select count(*)::int as count from audit_events
        where tenant_id = $1 and action = 'job.session.finalize.requeued'
          and metadata ->> 'sourceJobId' = $2`,
      [TENANT, dead.id],
    );
    assert.equal(replayAudits.rows[0].count, 1);

    await assert.rejects(
      () => store.requeueDead({ tenantId: TENANT, jobId: replay.id, operatorId: ACTOR }),
      /dead job/i,
    );
  });

  await t.test("runtime bounds a hung handler, records a fixed retry, and emits closed metrics", async () => {
    const queued = await store.enqueue(request({ kind: "session.evaluate" }));
    const runtime = createJobRuntime({
      store,
      workerId: "worker-runtime",
      leaseMs: 250,
      operationTimeoutMs: 40,
      retryBaseMs: 10,
      handlers: {
        "session.evaluate": async () => new Promise(() => {}),
      },
    });
    const outcome = await runtime.runOne(TENANT, { jobId: queued.id });
    assert.equal(outcome.outcome, "retry");
    assert.equal(outcome.errorCode, "operation_timeout");
    const stored = await store.get({ tenantId: TENANT, jobId: queued.id });
    assert.equal(stored.status, "retry");
    assert.equal(stored.lastErrorCode, "operation_timeout");
    const metrics = runtime.renderMetrics();
    assert.match(metrics, /job_attempts_total\{kind="session\.evaluate",outcome="retry"\} 1/);
    assert.doesNotMatch(metrics, new RegExp(queued.id));
    assert.doesNotMatch(metrics, new RegExp(TENANT));
    await runtime.drain({ timeoutMs: 100 });
  });

  await t.test("runtime commits the handler effect and completion in one fenced transaction", async () => {
    const queued = await store.enqueue(request({ kind: "privacy.export" }));
    const effectId = `audit-runtime-${randomUUID()}`;
    const runtime = createJobRuntime({
      store,
      workerId: "worker-success",
      leaseMs: 500,
      operationTimeoutMs: 100,
      retryBaseMs: 10,
      handlers: {
        "privacy.export": async ({ job }) => ({
          result: { manifestId: job.subjectId },
          commit: async (tx) => {
            await tx`
              insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id)
              values (${effectId}, ${TENANT}, ${ACTOR}, 'test.runtime.effect', 'background_job', ${job.id})`;
          },
        }),
      },
    });
    const outcome = await runtime.runOne(TENANT, { jobId: queued.id });
    assert.equal(outcome.outcome, "completed");
    const stored = await store.get({ tenantId: TENANT, jobId: queued.id });
    assert.equal(stored.status, "completed");
    assert.deepEqual(stored.result, { manifestId: queued.subjectId });
    const effects = await admin.query("select count(*)::int as count from audit_events where id = $1", [effectId]);
    assert.equal(effects.rows[0].count, 1);
  });

  await t.test("runtime yields to a newer lease without mutating the authoritative attempt", async () => {
    const queued = await store.enqueue(request({ kind: "session.finalize", maxAttempts: 3 }));
    const runtime = createJobRuntime({
      store,
      workerId: "worker-stale",
      leaseMs: 500,
      operationTimeoutMs: 100,
      retryBaseMs: 10,
      handlers: {
        "session.finalize": async ({ job }) => {
          await admin.query(
            `update background_jobs
                set attempt_count = attempt_count + 1,
                    lease_generation = lease_generation + 1,
                    lease_owner = 'worker-authoritative',
                    lease_expires_at = now() + interval '5 seconds',
                    updated_at = now()
              where id = $1`,
            [job.id],
          );
          return {
            result: { status: "must-not-commit" },
            commit: async () => {
              throw new Error("the stale commit callback must not run");
            },
          };
        },
      },
    });

    const outcome = await runtime.runOne(TENANT, { jobId: queued.id });
    assert.deepEqual(outcome, { outcome: "stale", job: null });
    const stored = await store.get({ tenantId: TENANT, jobId: queued.id });
    assert.equal(stored.status, "running");
    assert.equal(stored.leaseOwner, "worker-authoritative");
    assert.equal(stored.attemptCount, 2);
    assert.equal(stored.leaseGeneration, 2);
    assert.equal(stored.lastErrorCode, null);
    assert.equal(stored.result, null);
    assert.match(
      runtime.renderMetrics(),
      /job_attempts_total\{kind="session\.finalize",outcome="stale"\} 1/,
    );
  });

  await t.test("payload and result boundaries reject raw or unbounded sensitive documents", async () => {
    await assert.rejects(
      () => store.enqueue(request({ payload: { transcript: "learner speech" } })),
      /forbidden field/i,
    );
    await assert.rejects(
      () => store.enqueue(request({ payload: { sessionId: "x".repeat(9_000) } })),
      /bounded JSON|oversized string/i,
    );
    assert.throws(
      () => createJobRuntime({
        store,
        workerId: "bad-runtime",
        leaseMs: 40,
        operationTimeoutMs: 40,
        retryBaseMs: 10,
        handlers: {},
      }),
      /leaseMs must exceed operationTimeoutMs/,
    );
  });
  } finally {
    await fixture.close();
  }
});

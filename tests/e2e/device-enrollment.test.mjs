import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import {
  parseProvisionArguments,
  provisionDeviceEnrollment,
} from "../../server/scripts/provision-device-enrollment.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import {
  generateDeviceToken,
  hashDeviceToken,
} from "../../server/src/identity/device-sessions.mjs";
import { createApplication } from "../../server/src/app.mjs";
import { createInferenceRuntime } from "../../server/src/inference/local.mjs";
import { createJobRuntime } from "../../server/src/jobs/runtime.mjs";
import { createJobStore } from "../../server/src/jobs/store.mjs";
import { createWorkflowHandlers } from "../../server/src/jobs/workflows.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import { ROUTES } from "../../server/src/routes/index.mjs";
import { createTestDatabase } from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const TENANT = "hikmah-pilot-erbil";
const DEVICE_ROUTE_KEYS = [
  "DELETE /v1/device-sessions/current",
  "POST /v1/device-enrollments:exchange",
  "POST /v1/device-sessions:refresh",
];

const appConnectionString = (connectionString, roleName, password) => {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
};

async function liveFixture(t, prefix) {
  const database = await createTestDatabase(t, prefix);
  if (!database) return null;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_device_e2e_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "device-e2e-test-password";
  await provisionApplicationRole({
    connectionString: database.connectionString,
    roleName,
    password,
  });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const databaseUrl = appConnectionString(database.connectionString, roleName, password);
  const audioObjectStore = {
    async get() { return null; },
    async listLearner() { return []; },
    async deleteLearner() { return { deletedObjectKeys: [] }; },
    async assertReady() {},
    async close() {},
  };
  const app = createApplication({
    databaseUrl,
    deviceIdentityEnabled: true,
    enforceRestrictedDbRole: true,
    allowHeaderAuth: true,
    audioObjectStore,
    rateLimitEnabled: false,
    logger: false,
  });
  await app.ready();

  const workerDb = createDb(databaseUrl);
  const inference = createInferenceRuntime({
    predictAlignment: async () => assert.fail("device privacy work must not align"),
    predictTajweed: async () => assert.fail("device privacy work must not evaluate Tajweed"),
    transcribeSession: async () => assert.fail("device privacy work must not transcribe"),
  });
  const workerRuntime = createJobRuntime({
    store: createJobStore({ db: workerDb }),
    handlers: createWorkflowHandlers({
      db: workerDb,
      inference,
      audioObjectStore,
      upstreamTimeoutMs: 1_000,
    }),
    workerId: `device-e2e-${randomUUID()}`,
    leaseMs: 2_000,
    operationTimeoutMs: 1_500,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  let workerRunning = true;
  const workerLoop = (async () => {
    while (workerRunning) {
      const attempt = await workerRuntime.runOne(TENANT);
      if (attempt.outcome === "idle") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  })();

  return {
    admin,
    app,
    databaseUrl,
    async close() {
      workerRunning = false;
      await workerLoop;
      await workerDb.end();
      await app.close();
      await admin.end();
      const cleanup = new Client({ connectionString: database.connectionString });
      await cleanup.connect();
      await cleanup.query(`drop owned by "${roleName}" cascade`);
      await cleanup.query(`drop role if exists "${roleName}"`);
      await cleanup.end();
    },
  };
}

async function seedInvitation(admin, invitationToken, suffix = randomUUID()) {
  const invitationId = `device-invitation-${suffix}`;
  const auditId = `device-invitation-audit-${suffix}`;
  await admin.query(
    `insert into audit_events
       (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
     values ($1, $2, 'admin-1', 'device.enrollment.invited', 'user', 'learner-1', '{}')`,
    [auditId, TENANT],
  );
  await admin.query(
    `insert into device_enrollment_invitations
       (id, tenant_id, user_id, created_by, token_hash, expires_at, audit_event_id)
     values ($1, $2, 'learner-1', 'admin-1', $3, now() + interval '1 hour', $4)`,
    [invitationId, TENANT, hashDeviceToken(invitationToken, "invitation"), auditId],
  );
  return invitationId;
}

const generic401 = (response) => {
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "missing or invalid authorization" });
};

test("the three device operations are owner-gated off by default and register only when enabled", async (t) => {
  const declared = ROUTES.filter((route) => route.ownerGate === "device-identity");
  assert.deepEqual(declared.map((route) => route.key).sort(), DEVICE_ROUTE_KEYS);

  const disabled = createApplication({ logger: false });
  const enabled = createApplication({ logger: false, deviceIdentityEnabled: true });
  t.after(async () => {
    await enabled.close();
    await disabled.close();
  });
  await disabled.ready();
  await enabled.ready();

  for (const route of declared) {
    assert.equal(disabled.localRouteKeys.includes(route.key), false, `${route.key} enabled by default`);
    assert.equal(enabled.localRouteKeys.includes(route.key), true, `${route.key} not enabled explicitly`);
  }

  const hidden = await disabled.inject({
    method: "POST",
    url: "/v1/device-enrollments:exchange",
    payload: { invitationToken: generateDeviceToken("invitation") },
  });
  assert.equal(hidden.statusCode, 404);
});

test("the composition boundary refuses a non-boolean device identity gate", () => {
  for (const deviceIdentityEnabled of ["1", "true", 1, null]) {
    assert.throws(
      () => createApplication({ logger: false, deviceIdentityEnabled }),
      /deviceIdentityEnabled must be boolean/,
    );
  }
});

test("exchange is single-use, server-authoritative, hash-only, and strictly shaped", async (t) => {
  const fixture = await liveFixture(t, "device_enrollment_exchange");
  if (!fixture) return;
  const { admin, app } = fixture;
  try {
    const extraToken = generateDeviceToken("invitation");
    await seedInvitation(admin, extraToken, "extra-fields");
    const extra = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: {
        invitationToken: extraToken,
        tenantId: "attacker-tenant",
        role: "admin",
        userId: "admin-1",
      },
    });
    assert.equal(extra.statusCode, 422);

    const invitationToken = generateDeviceToken("invitation");
    await seedInvitation(admin, invitationToken);
    const forged = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken: generateDeviceToken("invitation") },
    });
    generic401(forged);

    const expiredToken = generateDeviceToken("invitation");
    const expiredId = await seedInvitation(admin, expiredToken, "expired");
    await admin.query(
      `update device_enrollment_invitations
          set created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 minute'
        where id = $1`,
      [expiredId],
    );
    const expired = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken: expiredToken },
    });
    generic401(expired);

    const attempts = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/device-enrollments:exchange",
        payload: { invitationToken },
      }),
      app.inject({
        method: "POST",
        url: "/v1/device-enrollments:exchange",
        payload: { invitationToken },
      }),
    ]);
    assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 401]);
    const issued = attempts.find((response) => response.statusCode === 200).json();
    assert.deepEqual(Object.keys(issued), [
      "accessExpiresAt",
      "accessToken",
      "absoluteExpiresAt",
      "idleExpiresAt",
      "refreshToken",
    ]);
    generic401(attempts.find((response) => response.statusCode === 401));

    const stored = await admin.query(
      `select tenant_id, user_id, access_token_hash, refresh_token_hash
         from device_sessions where access_token_hash = $1`,
      [hashDeviceToken(issued.accessToken, "access")],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].tenant_id, TENANT);
    assert.equal(stored.rows[0].user_id, "learner-1");
    assert.equal(stored.rows[0].refresh_token_hash, hashDeviceToken(issued.refreshToken, "refresh"));
    assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(issued.accessToken));
    assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(issued.refreshToken));

    const reused = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken },
    });
    generic401(reused);
  } finally {
    await fixture.close();
  }
});

test("refresh replay commits family revocation before generic 401", async (t) => {
  const fixture = await liveFixture(t, "device_enrollment_refresh");
  if (!fixture) return;
  const { admin, app } = fixture;
  try {
    const invitationToken = generateDeviceToken("invitation");
    await seedInvitation(admin, invitationToken);
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken },
    });
    assert.equal(enrolled.statusCode, 200);
    const first = enrolled.json();

    const refreshAttempts = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/device-sessions:refresh",
        payload: { refreshToken: first.refreshToken },
      }),
      app.inject({
        method: "POST",
        url: "/v1/device-sessions:refresh",
        payload: { refreshToken: first.refreshToken },
      }),
    ]);
    assert.deepEqual(refreshAttempts.map((response) => response.statusCode).sort(), [200, 401]);
    generic401(refreshAttempts.find((response) => response.statusCode === 401));
    const second = refreshAttempts.find((response) => response.statusCode === 200).json();
    assert.notEqual(second.accessToken, first.accessToken);
    assert.notEqual(second.refreshToken, first.refreshToken);

    const oldAccess = await app.inject({
      method: "GET",
      url: "/v1/learner/progress",
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    generic401(oldAccess);

    const replayAgain = await app.inject({
      method: "POST",
      url: "/v1/device-sessions:refresh",
      payload: { refreshToken: first.refreshToken },
    });
    generic401(replayAgain);

    const revokedWinner = await app.inject({
      method: "GET",
      url: "/v1/learner/progress",
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    generic401(revokedWinner);
    const statuses = await admin.query(
      "select generation, status from device_sessions where user_id = 'learner-1' order by generation",
    );
    assert.deepEqual(statuses.rows, [
      { generation: 0, status: "replayed" },
      { generation: 1, status: "revoked" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("DELETE current accepts only the active device access credential and revokes its family", async (t) => {
  const fixture = await liveFixture(t, "device_enrollment_logout");
  if (!fixture) return;
  const { app } = fixture;
  try {
    const invitationToken = generateDeviceToken("invitation");
    await seedInvitation(fixture.admin, invitationToken);
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken },
    });
    const issued = enrolled.json();

    const noCredential = await app.inject({
      method: "DELETE",
      url: "/v1/device-sessions/current",
    });
    generic401(noCredential);

    const revoked = await app.inject({
      method: "DELETE",
      url: "/v1/device-sessions/current",
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(revoked.json(), { revoked: true });

    const laterAccess = await app.inject({
      method: "GET",
      url: "/v1/learner/progress",
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    generic401(laterAccess);
    const laterRefresh = await app.inject({
      method: "POST",
      url: "/v1/device-sessions:refresh",
      payload: { refreshToken: issued.refreshToken },
    });
    generic401(laterRefresh);
  } finally {
    await fixture.close();
  }
});

test("provisioning validates a stored admin, creates only approved roles, and never accepts credential material", async (t) => {
  const fixture = await liveFixture(t, "device_enrollment_provisioning");
  if (!fixture) return;
  const { admin, databaseUrl } = fixture;
  try {
    assert.throws(
      () => parseProvisionArguments([
        "--tenant-id", TENANT,
        "--admin-id", "admin-1",
        "--user-id", "learner-1",
        "--invitation-token", generateDeviceToken("invitation"),
      ]),
      /unknown argument/,
    );
    assert.throws(
      () => parseProvisionArguments([
        "--tenant-id", TENANT,
        "--admin-id", "admin-1",
        "--user-id", "learner-1",
        "--role", "admin",
      ]),
      /unknown argument/,
    );

    await assert.rejects(
      provisionDeviceEnrollment({
        databaseUrl,
        tenantId: TENANT,
        adminId: "teacher-1",
        userId: "scholar-1",
      }),
      /existing in-tenant admin is required/,
    );

    const existing = await provisionDeviceEnrollment({
      databaseUrl,
      tenantId: TENANT,
      adminId: "admin-1",
      userId: "scholar-1",
    });
    assert.ok(existing.invitationToken.startsWith("qrai_inv_v1."));
    assert.equal(existing.createdUser, false);
    const storedExisting = await admin.query(
      `select dei.tenant_id, dei.user_id, dei.created_by, dei.token_hash,
              ae.actor_id, ae.action, ae.metadata
         from device_enrollment_invitations dei
         join audit_events ae on ae.id = dei.audit_event_id
        where dei.id = $1`,
      [existing.invitationId],
    );
    assert.deepEqual(
      {
        tenantId: storedExisting.rows[0].tenant_id,
        userId: storedExisting.rows[0].user_id,
        createdBy: storedExisting.rows[0].created_by,
        actorId: storedExisting.rows[0].actor_id,
        action: storedExisting.rows[0].action,
      },
      {
        tenantId: TENANT,
        userId: "scholar-1",
        createdBy: "admin-1",
        actorId: "admin-1",
        action: "device.enrollment.invited",
      },
    );
    assert.equal(
      storedExisting.rows[0].token_hash,
      hashDeviceToken(existing.invitationToken, "invitation"),
    );
    assert.doesNotMatch(JSON.stringify(storedExisting.rows[0]), new RegExp(existing.invitationToken));
    assert.doesNotMatch(JSON.stringify(storedExisting.rows[0].metadata), /token|secret/i);

    await assert.rejects(
      provisionDeviceEnrollment({
        databaseUrl,
        tenantId: TENANT,
        adminId: "admin-1",
        userId: "device-created-admin",
        newUser: { displayName: "Forbidden Admin", language: "ckb", role: "admin" },
      }),
      /learner, teacher, or scholar/,
    );
    assert.equal(
      (await admin.query("select count(*)::int as count from users where id = 'device-created-admin'"))
        .rows[0].count,
      0,
    );

    const created = await provisionDeviceEnrollment({
      databaseUrl,
      tenantId: TENANT,
      adminId: "admin-1",
      userId: "device-created-teacher",
      newUser: { displayName: "Provisioned Teacher", language: "ckb", role: "teacher" },
    });
    assert.equal(created.createdUser, true);
    assert.deepEqual(
      (await admin.query(
        "select tenant_id, role, display_name, language from users where id = 'device-created-teacher'",
      )).rows[0],
      {
        tenant_id: TENANT,
        role: "teacher",
        display_name: "Provisioned Teacher",
        language: "ckb",
      },
    );

    const commandPath = fileURLToPath(
      new URL("../../server/scripts/provision-device-enrollment.mjs", import.meta.url),
    );
    const command = spawnSync(
      process.execPath,
      [commandPath, "--tenant-id", TENANT, "--admin-id", "admin-1", "--user-id", "learner-1"],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stderr, "");
    const commandResult = JSON.parse(command.stdout);
    assert.equal(command.stdout.split(commandResult.invitationToken).length - 1, 1);
    assert.equal(commandResult.userId, "learner-1");

    const forbiddenCanary = generateDeviceToken("invitation");
    const rejectedCommand = spawnSync(
      process.execPath,
      [
        commandPath,
        "--tenant-id", TENANT,
        "--admin-id", "admin-1",
        "--user-id", "learner-1",
        "--invitation-token", forbiddenCanary,
      ],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    assert.equal(rejectedCommand.status, 1);
    assert.equal(rejectedCommand.stdout, "");
    assert.equal(rejectedCommand.stderr, "device enrollment provisioning failed\n");
    assert.ok(!rejectedCommand.stderr.includes(forbiddenCanary));
  } finally {
    await fixture.close();
  }
});

test("privacy inventory exposes safe device counts and deletion removes credentials before later user erasure", async (t) => {
  const fixture = await liveFixture(t, "device_enrollment_privacy");
  if (!fixture) return;
  const { admin, app, databaseUrl } = fixture;
  try {
    const userId = "device-privacy-learner";
    const firstInvitation = await provisionDeviceEnrollment({
      databaseUrl,
      tenantId: TENANT,
      adminId: "admin-1",
      userId,
      newUser: { displayName: "Privacy Learner", language: "ckb", role: "learner" },
    });
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/device-enrollments:exchange",
      payload: { invitationToken: firstInvitation.invitationToken },
    });
    assert.equal(enrolled.statusCode, 200);
    const secondInvitation = await provisionDeviceEnrollment({
      databaseUrl,
      tenantId: TENANT,
      adminId: "admin-1",
      userId,
    });

    const headers = {
      "x-tenant-id": TENANT,
      "x-user-id": "admin-1",
      "x-user-role": "admin",
    };
    const exported = await app.inject({
      method: "POST",
      url: "/v1/privacy/export",
      headers,
      payload: { learnerId: userId },
    });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.ok(exported.json().includedRecords.includes("device_session_count:1"));
    assert.ok(exported.json().includedRecords.includes("device_enrollment_invitation_count:2"));
    const exportBytes = exported.body;
    for (const credential of [
      firstInvitation.invitationToken,
      secondInvitation.invitationToken,
      enrolled.json().accessToken,
      enrolled.json().refreshToken,
    ]) {
      assert.ok(!exportBytes.includes(credential), "privacy export exposed raw credential material");
    }
    assert.doesNotMatch(exportBytes, /[0-9a-f]{64}/i, "privacy export exposed a credential hash");

    const deleted = await app.inject({
      method: "POST",
      url: "/v1/privacy/delete",
      headers,
      payload: { learnerId: userId },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.ok(deleted.json().deletedRecords.includes("device_session_count:1"));
    assert.ok(deleted.json().deletedRecords.includes("device_enrollment_invitation_count:2"));
    const remaining = await admin.query(
      `select
         (select count(*)::int from device_sessions where user_id = $1) as sessions,
         (select count(*)::int from device_enrollment_invitations where user_id = $1) as invitations`,
      [userId],
    );
    assert.deepEqual(remaining.rows[0], { sessions: 0, invitations: 0 });
  } finally {
    await fixture.close();
  }
});

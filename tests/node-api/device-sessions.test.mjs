import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { migrateDatabase } from "../../server/scripts/migrate.mjs";
import { provisionApplicationRole } from "../../server/scripts/provision-role.mjs";
import {
  DEVICE_ACCESS_PREFIX,
  DEVICE_INVITATION_PREFIX,
  DEVICE_REFRESH_PREFIX,
  exchangeDeviceInvitation,
  generateDeviceToken,
  hashDeviceToken,
  resolveDeviceAccess,
  revokeDeviceSessionFamily,
  rotateDeviceSession,
} from "../../server/src/identity/device-sessions.mjs";
import { ApiError, resolveActor } from "../../server/src/lib/authz.mjs";
import { createDb } from "../../server/src/lib/db.mjs";
import {
  createTestDatabase,
} from "../migrations/lib/postgres.mjs";

const { Client } = pg;
const TENANT = "hikmah-pilot-erbil";

const appConnectionString = (connectionString, roleName, password) => {
  const url = new URL(connectionString);
  url.username = roleName;
  url.password = password;
  return url.toString();
};

async function deviceDatabase(t, prefix) {
  const database = await createTestDatabase(t, prefix);
  if (!database) return null;
  await migrateDatabase({ connectionString: database.connectionString });

  const roleName = `qrai_device_runtime_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "device-runtime-test-password";
  await provisionApplicationRole({
    connectionString: database.connectionString,
    roleName,
    password,
  });

  const admin = new Client({ connectionString: database.connectionString });
  await admin.connect();
  const db = createDb(appConnectionString(database.connectionString, roleName, password));
  return {
    admin,
    db,
    async close() {
      await db.end();
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

const isUnauthorized = (error) =>
  error instanceof ApiError &&
  error.status === 401 &&
  error.message === "missing or invalid authorization";

test("device credentials are 256-bit, domain-prefixed, and hash to a fixed database value", () => {
  const cases = [
    ["access", DEVICE_ACCESS_PREFIX],
    ["refresh", DEVICE_REFRESH_PREFIX],
    ["invitation", DEVICE_INVITATION_PREFIX],
  ];
  for (const [kind, prefix] of cases) {
    const first = generateDeviceToken(kind);
    const second = generateDeviceToken(kind);
    assert.match(first, new RegExp(`^${prefix.replace(".", "\\.")}[A-Za-z0-9_-]{43}$`));
    assert.notEqual(first, second);
    assert.match(hashDeviceToken(first, kind), /^[0-9a-f]{64}$/);
    assert.equal(hashDeviceToken(first, kind), hashDeviceToken(first, kind));
    assert.throws(() => hashDeviceToken(second, kind === "access" ? "refresh" : "access"));
  }
  assert.throws(() => generateDeviceToken("session"));
  assert.throws(() => hashDeviceToken("raw-secret-with-no-domain", "access"));
});

test("invitation exchange stores hashes only and access resolves the current database role", async (t) => {
  const fixture = await deviceDatabase(t, "device_runtime_exchange");
  if (!fixture) return;
  const { admin, db } = fixture;
  try {
    const invitationToken = generateDeviceToken("invitation");
    const invitationId = await seedInvitation(admin, invitationToken);

    const issuedAt = Date.now();
    const issued = await exchangeDeviceInvitation(db, invitationToken);
    assert.deepEqual(Object.keys(issued), [
      "accessExpiresAt",
      "accessToken",
      "absoluteExpiresAt",
      "idleExpiresAt",
      "refreshToken",
    ]);
    assert.ok(issued.accessToken.startsWith(DEVICE_ACCESS_PREFIX));
    assert.ok(issued.refreshToken.startsWith(DEVICE_REFRESH_PREFIX));
    for (const [field, expectedMs] of [
      ["accessExpiresAt", 15 * 60 * 1000],
      ["idleExpiresAt", 7 * 24 * 60 * 60 * 1000],
      ["absoluteExpiresAt", 30 * 24 * 60 * 60 * 1000],
    ]) {
      const observedMs = Date.parse(issued[field]) - issuedAt;
      assert.ok(
        observedMs >= expectedMs - 10_000 && observedMs <= expectedMs + 10_000,
        `${field} was ${observedMs}ms from issue time, expected ${expectedMs}ms`,
      );
    }

    const stored = await admin.query(
      `select access_token_hash, refresh_token_hash, status, generation
         from device_sessions where user_id = 'learner-1'
         order by created_at desc limit 1`,
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].access_token_hash, hashDeviceToken(issued.accessToken, "access"));
    assert.equal(stored.rows[0].refresh_token_hash, hashDeviceToken(issued.refreshToken, "refresh"));
    assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(issued.accessToken));
    assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(issued.refreshToken));
    assert.equal(stored.rows[0].status, "active");
    assert.equal(stored.rows[0].generation, 0);
    assert.ok((await admin.query("select consumed_at from device_enrollment_invitations where id = $1", [invitationId])).rows[0].consumed_at);

    const first = await resolveDeviceAccess(db, issued.accessToken);
    assert.deepEqual(first.actor, { tenantId: TENANT, userId: "learner-1", role: "learner" });

    await admin.query("update users set role = 'teacher' where id = 'learner-1'");
    const changed = await resolveActor(
      { method: "GET", headers: { authorization: `Bearer ${issued.accessToken}` } },
      { jwtSecret: "compatibility-secret", allowHeaderAuth: false, db },
    );
    assert.deepEqual(changed.actor, { tenantId: TENANT, userId: "learner-1", role: "teacher" });

    await assert.rejects(() => exchangeDeviceInvitation(db, invitationToken), isUnauthorized);
    await assert.rejects(
      () => resolveDeviceAccess(db, generateDeviceToken("access")),
      isUnauthorized,
    );
  } finally {
    await fixture.close();
  }
});

test("refresh rotation is single-winner and replay durably revokes the whole family", async (t) => {
  const fixture = await deviceDatabase(t, "device_runtime_replay");
  if (!fixture) return;
  const { admin, db } = fixture;
  try {
    const invitationToken = generateDeviceToken("invitation");
    await seedInvitation(admin, invitationToken);
    const issued = await exchangeDeviceInvitation(db, invitationToken);

    const attempts = await Promise.allSettled([
      rotateDeviceSession(db, issued.refreshToken),
      rotateDeviceSession(db, issued.refreshToken),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.ok(attempts.find((result) => result.status === "rejected")?.reason instanceof ApiError);

    const rows = await admin.query(
      `select generation, status, revoked_at, rotated_at
         from device_sessions where user_id = 'learner-1' order by generation`,
    );
    assert.deepEqual(rows.rows.map(({ generation, status }) => ({ generation, status })), [
      { generation: 0, status: "replayed" },
      { generation: 1, status: "revoked" },
    ]);
    assert.ok(rows.rows.every((row) => row.revoked_at));
    assert.ok(rows.rows[0].rotated_at);
    assert.equal(
      (await admin.query(
        "select count(*)::int as count from audit_events where action = 'device.session.refresh_replay'",
      )).rows[0].count,
      1,
    );
    const winner = attempts.find((result) => result.status === "fulfilled").value;
    await assert.rejects(() => resolveDeviceAccess(db, winner.accessToken), isUnauthorized);
  } finally {
    await fixture.close();
  }
});

test("logout revokes the active family and every later use is the same generic 401", async (t) => {
  const fixture = await deviceDatabase(t, "device_runtime_logout");
  if (!fixture) return;
  const { admin, db } = fixture;
  try {
    const invitationToken = generateDeviceToken("invitation");
    await seedInvitation(admin, invitationToken);
    const issued = await exchangeDeviceInvitation(db, invitationToken);

    assert.deepEqual(await revokeDeviceSessionFamily(db, issued.accessToken), { revoked: true });
    await assert.rejects(() => resolveDeviceAccess(db, issued.accessToken), isUnauthorized);
    await assert.rejects(() => rotateDeviceSession(db, issued.refreshToken), isUnauthorized);
    assert.equal(
      (await admin.query("select status from device_sessions where user_id = 'learner-1'")).rows[0].status,
      "revoked",
    );
    assert.equal(
      (await admin.query(
        "select count(*)::int as count from audit_events where action = 'device.session.revoked'",
      )).rows[0].count,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("the reserved device prefix fails closed without a database and still beats dev headers", async () => {
  const accessToken = generateDeviceToken("access");
  await assert.rejects(
    () =>
      resolveActor(
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-tenant-id": TENANT,
            "x-user-id": "admin-1",
            "x-user-role": "admin",
          },
        },
        { jwtSecret: "compatibility-secret", allowHeaderAuth: true },
      ),
    isUnauthorized,
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { createApplication } from "../../server/src/app.mjs";

const { Client } = pg;
const ADMIN_URL = process.env.MIGRATION_TEST_ADMIN_URL;

async function adminCapabilities(t) {
  if (!ADMIN_URL) {
    t.skip("MIGRATION_TEST_ADMIN_URL is not configured");
    return null;
  }
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  const { rows } = await client.query(`
    SELECT current_user AS role_name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    FROM pg_roles WHERE rolname = current_user
  `);
  await client.end();
  return rows[0];
}

async function expectReady(connectionString) {
  const app = createApplication({ databaseUrl: connectionString, rateLimitEnabled: false });
  try {
    await app.ready();
  } finally {
    await app.close().catch(() => {});
  }
}

async function temporaryRole(t, attributes) {
  const roleName = `qrai_guard_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const password = `qrai_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE "${roleName}" LOGIN ${attributes} PASSWORD '${password}'`);
  await admin.end();

  t.after(async () => {
    const cleanup = new Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
      [roleName],
    );
    await cleanup.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await cleanup.end();
  });

  const roleUrl = new URL(ADMIN_URL);
  roleUrl.username = roleName;
  roleUrl.password = password;
  return roleUrl.toString();
}

test("Fastify boot refuses the privileged administrative database role", async (t) => {
  const capabilities = await adminCapabilities(t);
  if (!capabilities) return;
  assert.ok(
    capabilities.rolsuper || capabilities.rolbypassrls || capabilities.rolcreatedb || capabilities.rolcreaterole,
    "the migration connection is not privileged, so this would be a hollow refusal proof",
  );
  await assert.rejects(
    () => expectReady(ADMIN_URL),
    /database role has forbidden capability (?:SUPERUSER|BYPASSRLS|CREATEDB|CREATEROLE)/,
  );
});

test("Fastify boot accepts a real restricted login role", async (t) => {
  const capabilities = await adminCapabilities(t);
  if (!capabilities) return;
  if (!capabilities.rolsuper && !capabilities.rolcreaterole) {
    t.skip("administrative connection cannot create the proof role");
    return;
  }

  const restrictedUrl = await temporaryRole(
    t,
    "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
  );
  await assert.doesNotReject(() => expectReady(restrictedUrl));
});

test("Fastify boot refuses a real BYPASSRLS login role", async (t) => {
  const capabilities = await adminCapabilities(t);
  if (!capabilities) return;
  if (!capabilities.rolsuper) {
    t.skip("only a superuser can create the isolated BYPASSRLS proof role");
    return;
  }

  const bypassUrl = await temporaryRole(
    t,
    "NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
  );
  await assert.rejects(() => expectReady(bypassUrl), /forbidden capability BYPASSRLS/);
});

test("the explicit development relaxation is narrow and opt-in", async (t) => {
  const capabilities = await adminCapabilities(t);
  if (!capabilities) return;
  const app = createApplication({
    databaseUrl: ADMIN_URL,
    enforceRestrictedDbRole: false,
    rateLimitEnabled: false,
  });
  try {
    await assert.doesNotReject(() => app.ready());
  } finally {
    await app.close();
  }
});

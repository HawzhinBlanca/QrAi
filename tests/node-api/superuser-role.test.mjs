import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDb } from "../../server/src/lib/db.mjs";

/**
 * Refuse to run against the database as a superuser / `BYPASSRLS` role.
 *
 * platform-api has refused that role since the RLS work. The Node port did not, and connects to the
 * SAME `DATABASE_URL`. Measured, both services booted with a superuser connection and no relaxation:
 *
 *     platform-api  panicked: "DB role 'postgres' is superuser/bypassrls — RLS tenant isolation is INERT"
 *     node-api      booted, and served real rows from GET /v1/quran/surahs
 *
 * Why it matters more than a missing assertion: all 17 tenant-isolation policies read
 *
 *     app.is_rls_bypass_enabled() OR tenant_id = app.current_tenant_id()
 *
 * and `app.is_rls_bypass_enabled()` is gated on `rolsuper`. One privileged connection makes the
 * whole policy set inert at once, and tenant isolation falls back to every handler remembering
 * `withTenant`. The handlers do — that is the belt. This is the braces.
 *
 * ── What ADR-0044 changed, and why this file was rewritten ──────────────────────────────────────
 * This used to import `superuserRoleProblem` from `services/node-api/lib/db.mjs` and drive it with a
 * stubbed `sql`. #388 retired that module into `server/`, where the check is `db.assertRestrictedRole()`
 * — wired at boot through `enforceRestrictedDbRole` (server/src/app.mjs) as an `onReady` hook, so it
 * completes before Fastify binds a socket. It is also STRICTER than the function it replaced:
 * CREATEDB, CREATEROLE and REPLICATION are refused alongside SUPERUSER and BYPASSRLS, because each
 * one can reach the policies or the data around them.
 *
 * It returns nothing and throws, so the stub table became a live assertion against the catalog: the
 * check is driven by `pg_roles`, and asserting it against a hand-written row would only prove the
 * stub agreed with itself. The branch this cannot reach directly is "the role query answered
 * nothing" — `assertRestrictedRole` fails closed there, and that is stated rather than demonstrated.
 *
 * DB-gated: every case here needs a real Postgres.
 */

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "..", "server", "src", "main.mjs");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/quran_ai";

const FORBIDDEN = ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "rolreplication"];

/** What the catalog says about the role this suite is actually connected as. */
async function connectedRole(db) {
  const [row] = await db.sql`
    SELECT current_user AS role_name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
           rolreplication
      FROM pg_roles WHERE rolname = current_user`;
  return row;
}

test("the restricted-role check agrees with the catalog, in whichever direction applies", async () => {
  // Driven by the real role rather than a fixture, so it is decisive under both local layouts: a
  // developer connected as a superuser and CI connected as `quran_ai_app`.
  const db = createDb(DATABASE_URL);
  try {
    const role = await connectedRole(db);
    assert.ok(role, "no pg_roles row for current_user — the query is broken, not the role");
    const privileges = FORBIDDEN.filter((flag) => role[flag]);

    if (privileges.length === 0) {
      await db.assertRestrictedRole();
      return;
    }

    const error = await db.assertRestrictedRole().then(
      () => null,
      (e) => e,
    );
    assert.ok(
      error,
      `role "${role.role_name}" holds ${privileges.join(", ")} and the check accepted it — every ` +
        "tenant policy is inert against this connection",
    );
    assert.match(error.message, /restricted runtime role/);
    assert.match(
      error.message,
      /forbidden capability/,
      "an operator cannot act on a refusal that does not name what is wrong",
    );
  } finally {
    await db.end();
  }
});

test("every forbidden capability is one the check actually looks at", () => {
  // The list above is the whole point of the guard, and a silent narrowing of it — dropping
  // REPLICATION, say — would leave this file green while the hole reopened. Read from the source so
  // the two cannot drift.
  const src = readFileSync(join(here, "..", "..", "server", "src", "lib", "db.mjs"), "utf8");
  for (const flag of FORBIDDEN) {
    assert.match(src, new RegExp(`\\b${flag}\\b`), `assertRestrictedRole no longer reads ${flag}`);
  }
});

// --- wired to the entry point ---

function boot(env, ms = 6000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL,
        NODE_API_BIND: "127.0.0.1:0",
        // Strong, so an exit is never the SECRETS guard answering in this test's name.
        JWT_SECRET: "a-jwt-secret-of-at-least-thirty-two-characters",
        REALTIME_GATEWAY_TICKET_SECRET: "a-ticket-secret-of-at-least-thirty-two-chars",
        ML_API_KEY: "a-real-ml-key",
        ASR_API_KEY: "a-real-asr-key",
        CORS_ALLOWED_ORIGINS: "https://app.example.com",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {});
    child.once("exit", (code) => resolve({ code, stderr }));
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr, stillRunning: true });
    }, ms);
  });
}

test("the entry point refuses to boot as a privileged role", async () => {
  const db = createDb(DATABASE_URL);
  let privileged;
  try {
    const role = await connectedRole(db);
    privileged = FORBIDDEN.some((flag) => role[flag]);
  } finally {
    await db.end();
  }
  // Only meaningful when the configured connection IS privileged. Under a restricted DATABASE_URL
  // the refusal has nothing to refuse, and the relaxation case below still proves the wiring.
  if (!privileged) return;

  const { code, stderr, stillRunning } = await boot({});
  assert.notEqual(stillRunning, true, `it kept running as a privileged role:\n${stderr}`);
  // Exit 1, not 2: the role check fails inside the `onReady` hook, so it travels out through the
  // graceful-shutdown path (`reason=startup-error`) rather than the argument-validation exits.
  // Asserted as non-zero-and-named rather than pinned to 1, because WHICH non-zero code it is
  // matters far less than that it stopped and said why.
  assert.notEqual(code, 0, `it exited cleanly as a privileged role:\n${stderr}`);
  assert.match(stderr, /forbidden capability SUPERUSER|forbidden capability BYPASSRLS/);
  assert.match(stderr, /restricted runtime role/);
});

test("ALLOW_SUPERUSER_DB_ROLE=1 relaxes it, as the parity harness relies on", async () => {
  // Without this the through-shell parity suite — which runs the port against this same database —
  // would stop booting entirely. The relaxation is the reason the refusal is safe to add.
  const res = await boot({ ALLOW_SUPERUSER_DB_ROLE: "1" });
  assert.notEqual(
    res.code,
    2,
    `the relaxation did not relax the role check:\n${res.stderr}`,
  );
});

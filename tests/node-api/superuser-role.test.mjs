import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { superuserRoleProblem } from "../../services/node-api/lib/db.mjs";

/**
 * The node-api port of `main.rs:197` — refuse to run against the database as a superuser /
 * `BYPASSRLS` role.
 *
 * platform-api has refused that role since the RLS work. This port did not, and connects to the
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
 * `withTenant`. The handlers do — that is the belt. This is the braces, and at cutover the port
 * serves 37 of 42 routes with none.
 *
 * Nothing compared the two because no test exercised a boot refusal through the shell — the same
 * shape as the missing UPSTREAM_TIMEOUT_SECS deadline, and the reason ADR-0034 says a port is only
 * ported where something compares it.
 *
 * DB-gated: the spawn cases need a real Postgres to connect to. The unit cases below do not, and
 * pin WHICH roles are refused; the spawn cases prove the function is WIRED to the entry point,
 * which is the failure a table of unit tests cannot see.
 */

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "..", "services", "node-api", "server.mjs");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/quran_ai";

// --- which roles are refused ---

/** A stub in the shape `postgres` returns: a tagged-template function resolving to rows. */
const sqlReturning = (rows) => () => Promise.resolve(rows);

test("a restricted role is accepted", async () => {
  const problem = await superuserRoleProblem(
    sqlReturning([{ rolname: "qrai_app", rolsuper: false, rolbypassrls: false }]),
  );
  assert.equal(problem, null);
});

for (const [label, row] of [
  ["a superuser", { rolname: "postgres", rolsuper: true, rolbypassrls: false }],
  ["a BYPASSRLS role", { rolname: "qrai_admin", rolsuper: false, rolbypassrls: true }],
  ["both at once", { rolname: "root", rolsuper: true, rolbypassrls: true }],
]) {
  test(`${label} is refused, and the message names it`, async () => {
    const problem = await superuserRoleProblem(sqlReturning([row]));
    assert.ok(problem, `${label} was accepted`);
    assert.match(problem, new RegExp(row.rolname), "an operator cannot act on an unnamed role");
    assert.match(problem, /RLS tenant isolation is INERT/);
  });
}

test("an unanswerable role query is refused, not assumed fine", async () => {
  // Fail CLOSED. If we cannot establish what role we are, we cannot claim RLS is enforced — and a
  // `catch { return null }` here would turn a database hiccup into a silent loss of tenant
  // isolation, which is strictly worse than not booting.
  const thrown = await superuserRoleProblem(() => Promise.reject(new Error("connection reset")));
  assert.match(thrown, /could not establish the database role/);

  const empty = await superuserRoleProblem(sqlReturning([]));
  assert.match(empty, /no pg_roles row/);
});

// --- wired to the entry point ---

function boot(env, ms = 5000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL,
        PLATFORM_API_UPSTREAM: "http://127.0.0.1:1",
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

const PORTED = { NODE_API_PORTED: "GET /v1/quran/surahs" };

test("the entry point refuses to boot as a superuser role when routes are ported", async () => {
  // DATABASE_URL here is the same superuser connection every local run uses, which is precisely why
  // this went unnoticed: the harness sets ALLOW_INSECURE_DEFAULTS=1, so nothing ever exercised the
  // un-relaxed path.
  const { code, stderr } = await boot(PORTED);
  assert.equal(code, 2, `expected exit 2, got ${code}. stderr:\n${stderr}`);
  assert.match(stderr, /RLS tenant isolation is INERT/);
  assert.match(stderr, /platform-api refuses the same role/, "say that the two services agree");
});

test("ALLOW_SUPERUSER_DB_ROLE=1 relaxes it, as the parity harness relies on", async () => {
  // Without this the through-shell parity suite — which runs the port against this same superuser
  // database — would stop booting entirely. The relaxation is the reason this change is safe.
  const res = await boot({ ...PORTED, ALLOW_SUPERUSER_DB_ROLE: "1" });
  assert.equal(res.stillRunning, true, `it exited (${res.code}):\n${res.stderr}`);
});

test("the legacy ALLOW_INSECURE_DEFAULTS also relaxes it, matching Rust", async () => {
  // `relaxed(ALLOW_SUPERUSER_DB_ROLE, LEGACY_ONE_OR_TRUE)` — insecure.rs accepts "1" and "true" at
  // the boot checks. tests/api-parity/lib/harness.mjs sets exactly this.
  const res = await boot({ ...PORTED, ALLOW_INSECURE_DEFAULTS: "1" });
  assert.equal(res.stillRunning, true, `it exited (${res.code}):\n${res.stderr}`);
});

test("a shell with NOTHING ported boots, because it never touches the database", async () => {
  // The design decision, pinned. With no ported routes `db` is null and this process is a pure
  // proxy: refusing over a role it will not use would be theatre, and would break the zero-ported
  // shell the parity suite starts on every gate. If someone later makes the check unconditional,
  // this fails and says why.
  const res = await boot({});
  assert.equal(res.stillRunning, true, `a pure proxy refused to boot (${res.code}):\n${res.stderr}`);
});

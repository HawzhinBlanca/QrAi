/**
 * PAR1 — the black-box harness for the API parity suite.
 * specs/api-parity-suite/plan.md
 *
 * Built and tested BEFORE a single test is ported, for the same reason Phase 5 built the fixture
 * normalizer first: a broken harness produces a suite whose error is invisible, because every test
 * it runs agrees with every other one.
 *
 * Three seams, and only three:
 *   startApi()          spawn the real platform-api binary with a chosen env, on its own port
 *   request()           the dev-header identity request shape (from scripts/smoke-api.mjs:11-30)
 *   withDb()/queryJson() the ONLY place a Postgres driver is named (ADR-0023)
 * plus startMockUpstream() for the ML/ASR proxy group.
 *
 * ── Why a process per configuration ─────────────────────────────────────────────────────────────
 * The Rust tests inject configuration in-process (`AppState::with_header_auth(..)`,
 * `.with_maintenance_mode(true)`, `.with_metrics_access(..)`). The BINARY reads all of it from env
 * exactly once, at AppState construction (lib.rs:78-91, auth.rs:37-45). So a black-box suite cannot
 * flip config between requests — it starts a server per configuration group. That is the one piece
 * of genuinely new machinery this phase needs.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

/** The debug binary; `cargo test` already builds this crate, so CI pays no extra compile. */
export const API_BIN =
  process.env.PARITY_API_BIN ?? "services/platform-api/target/debug/quran-ai-platform-api";

/**
 * REQUIRED, no fallback. This suite writes rows, deletes learners through the privacy path, and
 * relies on a known seed — pointing it at a developer's own database would destroy real data during
 * what they believed was a test run. Same rule as scripts/restore-db.sh and
 * scripts/capture-api-fixtures.mjs.
 *
 * It is deliberately the SAME variable the Rust integration suite already mutates
 * (package.json `test` script), not a new one: a separate variable that CI forgot to set would make
 * this suite skip silently while `verify.sh` still printed green.
 */
export const DATABASE_URL = process.env.DATABASE_URL;

export const TENANT = "hikmah-pilot-erbil";
export const OTHER_TENANT = "tenant-quran-ai";

/** Matches integration.rs:47-58 — the seeded identities the dev-header path maps roles onto. */
export const ROLE_USER_IDS = {
  learner: "learner-1",
  teacher: "teacher-1",
  scholar: "scholar-1",
  admin: "admin-1",
  ops: "ops-1",
};

/**
 * Mirrors what the Rust tests get in-process:
 *   ALLOW_HEADER_AUTH=1      they call AppState::with_header_auth(.., true)
 *   DISABLE_RATE_LIMIT=1     they call platform_router_with_rate_limit(state, FALSE)
 *   ALLOW_INSECURE_DEFAULTS=1 skips main.rs's production secret + superuser-role boot checks
 * A group that needs production-like boot behaviour overrides these explicitly.
 */
const BASE_ENV = {
  ALLOW_INSECURE_DEFAULTS: "1",
  ALLOW_HEADER_AUTH: "1",
  DISABLE_RATE_LIMIT: "1",
  JWT_SECRET: "test-jwt-secret",
  RUST_LOG: "error",
};

/**
 * PAR4 — deliberate weakenings, applied LAST so they override whatever a test asked for.
 *
 * A ported test that passes proves the assertion was transcribed, not that it is equivalent. These
 * exist so `scripts/verify-parity-teeth.sh` can demonstrate each guard actually fails when the
 * behaviour it guards is broken. A mutation that changes nothing is itself a finding: that test
 * never had teeth.
 */
const MUTATIONS = {
  // auth-disabled group: re-enable the spoofable dev-header identity the group exists to refuse.
  "header-auth-on": { ALLOW_HEADER_AUTH: "1" },
  // cors group: unset means permissive — lib.rs:143 falls back to AllowOrigin::any().
  "cors-permissive": { CORS_ALLOWED_ORIGINS: "" },
  // metrics group: "1" (not "true") flips metrics_dev_open, opening /metrics with no token.
  "metrics-dev-open": { ALLOW_INSECURE_DEFAULTS: "1" },
};

export const MUTATION = process.env.PARITY_MUTATE ?? null;
if (MUTATION && !(MUTATION in MUTATIONS) && MUTATION !== "rls-no-role-drop") {
  throw new Error(`unknown PARITY_MUTATE=${MUTATION}; known: ${Object.keys(MUTATIONS).join(", ")}, rls-no-role-drop`);
}

/**
 * The role the RLS probes drop to before asserting isolation. Default `quran_ai_app`, the
 * production restricted role (nosuperuser nobypassrls).
 *
 * The `rls-no-role-drop` mutation sets this to `session_user`, which makes `SET LOCAL ROLE` a no-op
 * — so the probe runs as whoever DATABASE_URL connected as. Under a superuser that bypasses RLS
 * unconditionally and the tests must go red. That mutation is meaningless if DATABASE_URL is
 * already restricted, which is why verify-parity-teeth.sh checks and refuses rather than reporting
 * a hollow pass.
 */
export const RLS_PROBE_ROLE = MUTATION === "rls-no-role-drop" ? "session_user" : "quran_ai_app";

export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarnessError";
  }
}

function requireDatabaseUrl() {
  if (!DATABASE_URL) {
    throw new HarnessError(
      "DATABASE_URL is required and has NO default — this suite mutates the database it points at.",
    );
  }
  return DATABASE_URL;
}

/**
 * Ask the OS for a free port, then release it.
 *
 * ponytail: TOCTOU — something could claim the port in the gap before the server binds. Accepted
 * because the alternative is editing main.rs, which logs the REQUESTED bind address rather than
 * `listener.local_addr()` (main.rs:220-225), so binding to :0 gives us no way to learn the real
 * port. Upgrade path: have main.rs log local_addr, then pass :0 and read it back.
 */
export function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the real platform-api binary and wait until it answers /health.
 *
 * Never adopts an already-running server: if the binary is missing this THROWS. A harness that fell
 * back to whatever answers on a well-known port would report green about a process nobody chose,
 * and a missing-binary skip is the false-green MIG5 rejected.
 */
export async function startApi({ env = {}, timeoutMs = 30_000, bin = API_BIN } = {}) {
  requireDatabaseUrl();
  if (!existsSync(bin)) {
    throw new HarnessError(
      `platform-api binary not found at ${bin}. Build it first:\n` +
        `  cargo build --manifest-path services/platform-api/Cargo.toml\n` +
        `This is a hard failure, never a skip — a skipped suite gates nothing.`,
    );
  }

  const port = await reservePort();
  const child = spawn(bin, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL,
      ...BASE_ENV,
      ...env,
      // Applied last: a mutation must beat whatever the test group asked for, or it proves nothing.
      ...(MUTATION ? (MUTATIONS[MUTATION] ?? {}) : {}),
      PLATFORM_API_BIND: `127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let exited = null;
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", () => {});
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw new HarnessError(
        `platform-api exited during startup (code=${exited.code} signal=${exited.signal}).\n` +
          `env overrides: ${JSON.stringify(env)}\n--- stderr ---\n${stderr.slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new HarnessError(
        `platform-api did not answer /health within ${timeoutMs}ms.\n--- stderr ---\n${stderr.slice(-2000)}`,
      );
    }
    await sleep(100);
  }

  /** SIGTERM first — main.rs:241 installs a graceful-shutdown handler — then SIGKILL if it lingers. */
  async function stopRust() {
    if (exited) return;
    child.kill("SIGTERM");
    const hardDeadline = Date.now() + 5_000;
    while (!exited && Date.now() < hardDeadline) await sleep(25);
    if (!exited) {
      child.kill("SIGKILL");
      while (!exited) await sleep(25);
    }
  }

  // Phase 7 N2: when PARITY_THROUGH_SHELL=1, put the Node strangler shell in front and hand the
  // tests ITS url instead. The 39 tests are unchanged — that is the point. A shell with zero routes
  // ported must be indistinguishable from the Rust service, and any header, cookie, or body mangling
  // in the proxy shows up here immediately rather than being blamed on a later port.
  if (process.env.PARITY_THROUGH_SHELL === "1") {
    const shell = await startShell({ upstream: baseUrl, env });
    return {
      baseUrl: shell.baseUrl,
      port: shell.port,
      upstreamUrl: baseUrl,
      pid: child.pid,
      get stderr() {
        return stderr + shell.stderr;
      },
      async stop() {
        await shell.stop();
        await stopRust();
      },
    };
  }

  return {
    baseUrl,
    port,
    pid: child.pid,
    get stderr() {
      return stderr;
    },
    /** SIGTERM first — main.rs:241 installs a graceful-shutdown handler — then SIGKILL if it lingers. */
    stop: stopRust,
  };
}

/**
 * One request, with the dev-header identity the Rust tests use (integration.rs:38-59).
 * Returns { status, headers, body } — body is parsed JSON, or the raw text when it is not JSON
 * (/metrics returns Prometheus text, and a test asserting on it must see it verbatim).
 */
export async function request(baseUrl, path, options = {}) {
  const { method = "GET", role, userId, tenant = TENANT, body, headers = {}, ...rest } = options;

  const identity = {};
  if (role) {
    identity["x-user-id"] = userId ?? ROLE_USER_IDS[role] ?? "unknown";
    identity["x-user-role"] = role;
  } else if (userId) {
    identity["x-user-id"] = userId;
  }
  if (tenant !== null) identity["x-tenant-id"] = tenant;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...identity, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...rest,
  });

  const text = await res.text();
  let parsed = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep the raw text
    }
  }
  return {
    status: res.status,
    headers: res.headers,
    body: parsed,
    text,
  };
}

/**
 * Run `fn` against a single connected client, so multi-statement work (a transaction, or
 * `SET LOCAL ROLE` followed by a query) shares one session. The RLS backstop test needs exactly
 * this — a per-statement connection would silently lose the role.
 *
 * The session tenant is set on connect, mirroring the Rust test pool's `after_connect`
 * (integration.rs:12-19). Without it, seeding a row as `quran_ai_app` is refused by the RLS WITH
 * CHECK policy — which is RLS working correctly, and was caught by these tests rather than
 * anticipated.
 *
 * Pass `tenant: null` for the two tests that are ABOUT the context: one needs a hostile tenant, the
 * other needs none at all, and a default applied behind their back would make both meaningless.
 */
export async function withDb(fn, { connectionString = DATABASE_URL, tenant = TENANT } = {}) {
  requireDatabaseUrl();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (tenant !== null) await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Convenience over withDb for a single statement. Returns rows.
 *
 * ponytail: a fresh connection per call. Fine at this suite's size; switch to a shared pool if the
 * connection setup ever dominates the run.
 */
export async function queryJson(sql, params = [], opts = {}) {
  return withDb(async (client) => (await client.query(sql, params)).rows, opts);
}

/** Build a connection string for a different role against the same database. */
export function urlForRole(user, password, base = DATABASE_URL) {
  const url = new URL(requireDatabaseUrl() && base);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * A stand-in ML/ASR upstream. `ML_INFERENCE_URL` is fixed when the server starts, so one mock
 * serves every path for a group; behaviour is swapped per test by reassigning `mock.respond`.
 * `mock.received` records what the proxy actually FORWARDED — which is how the
 * server-authoritative-consent overwrite is verified end to end (integration.rs:2273).
 */
export async function startMockUpstream(respond = () => ({ status: 200, body: {} })) {
  const received = [];
  let handler = respond;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      received.push({ path: req.url, method: req.method, headers: req.headers, body: parsed });
      const decision = handler({ path: req.url, body: parsed }) ?? {};
      // Fault injection (P5.3): `{ hang: true }` accepts the request, records it, and NEVER answers.
      // The socket is deliberately left open, so the only thing that can end the call is the
      // caller's own timeout — which is precisely what a wedged ML/ASR process looks like from
      // platform-api, and what `upstream_timeout()` exists to survive. Returning an error status
      // would test a different thing entirely: a server that is answering.
      if (decision.hang) return;
      const { status = 200, body = {}, contentType = "application/json" } = decision;
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });

  const port = await reservePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    set respond(fn) {
      handler = fn;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Unique suffix so tests never collide on a seeded id (integration.rs:3080).
 *
 * `${pid}-${counter}` alone solved collisions BETWEEN parallel test files in one run, and silently
 * failed to solve them ACROSS runs. The OS recycles PIDs, and none of these rows is ever deleted, so
 * a later run that happens to land on an earlier run's PID reuses its ayah refs and inherits its
 * SM-2 history: `learner_progress` still holds that row at `repetitions=2, interval_days=6`, so the
 * "first-ever review" returns `intervalDays: 17` and
 * `the SM-2 progression matches Rust step for step` fails on `17 !== 1`.
 *
 * Observed as a red `verify.sh` on 2026-08-04 with 98 such rows accumulated in the staging database.
 * It is a flake in the harness rather than a bug in either implementation, and it is dangerous
 * precisely because it looks like a parity failure — the thing the suite exists to detect.
 *
 * The random component removes cross-run collision; pid and counter stay for readability when
 * grepping a failure back to the run that produced it.
 */
let counter = 0;
export function uniqueSuffix() {
  counter += 1;
  return `${process.pid}-${counter}-${randomBytes(4).toString("hex")}`;
}

/**
 * Start the Node strangler shell in front of a running Rust service (Phase 7 N2).
 *
 * `NODE_API_PORTED` decides which routes the shell serves itself; unset means it proxies everything,
 * which is the configuration N2's acceptance requires the whole existing suite to pass under.
 */
export async function startShell({ upstream, env = {}, timeoutMs = 20_000 }) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["services/node-api/server.mjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL,
      ...BASE_ENV,
      ...env,
      ...(MUTATION ? (MUTATIONS[MUTATION] ?? {}) : {}),
      PLATFORM_API_UPSTREAM: upstream,
      NODE_API_BIND: `127.0.0.1:${port}`,
      NODE_API_PORTED: process.env.NODE_API_PORTED ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let exited = null;
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", () => {});
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw new HarnessError(
        `node-api shell exited during startup (code=${exited.code}).\n--- stderr ---\n${stderr.slice(-2000)}`,
      );
    }
    try {
      // /health is proxied, so a 200 proves BOTH processes are up and the proxy path works.
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new HarnessError(`node-api shell did not answer /health within ${timeoutMs}ms.\n${stderr.slice(-2000)}`);
    }
    await sleep(50);
  }

  return {
    baseUrl,
    port,
    get stderr() {
      return stderr;
    },
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const hard = Date.now() + 5_000;
      while (!exited && Date.now() < hard) await sleep(25);
      if (!exited) child.kill("SIGKILL");
      while (!exited) await sleep(25);
    },
  };
}

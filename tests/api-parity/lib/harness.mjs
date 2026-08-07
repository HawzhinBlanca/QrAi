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

/**
 * Explicit DB-mechanics fixture for migration 0033. Its signer is test-only and production trust is
 * empty, so this release-labelled row can exercise exact provenance without becoming release proof.
 */
export const DECLARED_TEST_ACOUSTIC_EVIDENCE = Object.freeze({
  modelVersion: "model-v0.3",
  evidenceId: "declared-test-acoustic-evidence-v1",
  evidenceSha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  modelArtifactSha256:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  datasetVersion: "declared-test-acoustic-dataset-v1",
  datasetManifestSha256:
    "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  calibratorId: "declared-test-calibrator-v1",
  calibratorArtifactSha256:
    "sha256:9999999999999999999999999999999999999999999999999999999999999999",
});

export async function ensureDeclaredTestAcousticEvidence() {
  const p = DECLARED_TEST_ACOUSTIC_EVIDENCE;
  await queryJson(
    `INSERT INTO eval_runs
       (id, tenant_id, model_version_id, dataset_version, metrics, word_alignment_f1, tajweed_f1,
        false_positive_rate, teacher_agreement_rate, unsourced_learner_outputs, passed,
        evaluation_task, evidence_id, evidence_kind, evidence_eligibility, release_eligible,
        evidence_payload, evidence_payload_sha256, candidate_id, model_artifact_sha256,
        dataset_manifest_sha256, split_manifest_sha256, split_id, evaluator_version,
        evaluator_source_sha256, evaluator_protocol_sha256, raw_row_manifest_sha256,
        raw_results_sha256, calibrator_id, calibrator_artifact_sha256, signer_key_id,
        signature_algorithm, signature_base64url, signed_at, evaluation_counts, slice_metrics,
        created_at)
     VALUES
       ('declared-test-acoustic-eval-v1', $1, $2, $3, '{}'::jsonb, 0, 0, 1, 0, 0, true,
        'acoustic-tajweed', $4, 'row-level-computed-evaluation', 'release-candidate', true,
        '{"declaredFixture":true}'::jsonb, $5, 'declared-test-candidate-v1', $6, $7,
        'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        'held-out', 'declared-test-evaluator-v1',
        'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        'sha256:6666666666666666666666666666666666666666666666666666666666666666',
        'sha256:7777777777777777777777777777777777777777777777777777777777777777',
        'sha256:8888888888888888888888888888888888888888888888888888888888888888',
        $8, $9, 'test-only-ephemeral', 'Ed25519',
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '2026-08-07T00:00:00Z',
        '{"negativeCount":1,"positiveCount":1,"reciterCount":2,"rowCount":2}'::jsonb,
        '[{"declaredFixture":true,"sliceId":"fixture-slice"}]'::jsonb,
        '1900-01-01T00:00:00Z')
     ON CONFLICT (id) DO UPDATE SET created_at = excluded.created_at`,
    [
      TENANT,
      p.modelVersion,
      p.datasetVersion,
      p.evidenceId,
      p.evidenceSha256,
      p.modelArtifactSha256,
      p.datasetManifestSha256,
      p.calibratorId,
      p.calibratorArtifactSha256,
    ],
  );
}

export async function insertDeclaredTestAcousticFinding({
  id,
  alignmentId,
  rule = "Ghunnah",
  severity = "warning",
  confidence = 0.9,
  explanation = "declared acoustic fixture",
  reviewStatus = "ai-suggested",
  sources = [],
  auditEventId,
}) {
  await ensureDeclaredTestAcousticEvidence();
  const p = DECLARED_TEST_ACOUSTIC_EVIDENCE;
  await queryJson(
    `INSERT INTO tajweed_findings
       (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status,
        source_refs, model_version_id, audit_event_id, analysis_basis,
        evaluation_evidence_id, evaluation_evidence_sha256, model_artifact_sha256,
        acoustic_dataset_version, acoustic_dataset_manifest_sha256, calibrator_id,
        calibrator_artifact_sha256)
     VALUES ($1, $2, $3, $4, $5, $6::float8::numeric, $7, $8, $9::jsonb, $10, $11,
             'acoustic', $12, $13, $14, $15, $16, $17, $18)`,
    [
      id,
      TENANT,
      alignmentId,
      rule,
      severity,
      confidence,
      explanation,
      reviewStatus,
      JSON.stringify(sources),
      p.modelVersion,
      auditEventId,
      p.evidenceId,
      p.evidenceSha256,
      p.modelArtifactSha256,
      p.datasetVersion,
      p.datasetManifestSha256,
      p.calibratorId,
      p.calibratorArtifactSha256,
    ],
  );
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
/**
 * Every base url in this process that is served by the NODE SHELL rather than by Rust.
 *
 * Exists so `assertAB` can refuse to compare an implementation with itself. Under
 * `PARITY_THROUGH_SHELL=1`, `startApi().baseUrl` IS a shell — so the natural-looking
 * `assertAB(shell.baseUrl, api.baseUrl, …)` put Node on both sides and passed by construction. That
 * wiring was in 13 of the 16 parity files and hid a measured `Meccan` vs `MECCAN` divergence in
 * canonical surah metadata across both verify.sh passes.
 *
 * A convention cannot prevent that — the wrong call is the one that reads correctly. A registry the
 * differ consults can, because the shell registers itself the moment it starts.
 */
export const SHELL_URLS = new Set();

export async function startShell({ upstream, env = {}, timeoutMs = 20_000 }) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server/src/main.mjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL,
      ...BASE_ENV,
      ...env,
      ...(MUTATION ? (MUTATIONS[MUTATION] ?? {}) : {}),
      PLATFORM_API_UPSTREAM: upstream,
      NODE_API_BIND: `127.0.0.1:${port}`,
      // The caller's routes UNIONED with the ambient ones — deliberately not either alone.
      //
      // This line sits after `...env`, so it used to discard
      // `startShell({ env: { NODE_API_PORTED: … } })` silently: the shell ported nothing, proxied
      // everything to Rust, and the test measured Rust while its author believed it was measuring
      // Node. Same failure the `SHELL_URLS` guard exists to stop, by a different road.
      //
      // Union rather than override, because the two sources mean different things. A file's own list
      // says "these are the routes I am about" and must hold when the file is run directly, which is
      // how a person runs it. The ambient list is verify.sh's second pass saying "serve every
      // PORTABLE route", and letting a file narrow that would quietly shrink the pass that exists to
      // be exhaustive. Union satisfies both: standalone the file gets its own routes, and under
      // verify.sh it gets a superset.
      NODE_API_PORTED: [env.NODE_API_PORTED, process.env.NODE_API_PORTED]
        .filter((v) => typeof v === "string" && v.trim() !== "")
        .join(","),
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

  SHELL_URLS.add(baseUrl);

  return {
    baseUrl,
    port,
    get stderr() {
      return stderr;
    },
    async stop() {
      SHELL_URLS.delete(baseUrl);
      if (exited) return;
      child.kill("SIGTERM");
      const hard = Date.now() + 5_000;
      while (!exited && Date.now() < hard) await sleep(25);
      if (!exited) child.kill("SIGKILL");
      while (!exited) await sleep(25);
    },
  };
}

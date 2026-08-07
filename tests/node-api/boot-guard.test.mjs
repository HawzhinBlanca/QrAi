import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOW_INSECURE_SECRETS,
  LEGACY_VAR,
  insecureSecretProblems,
} from "../../server/src/lib/insecure.mjs";

/**
 * The node-api port of `main.rs` `ensure_secure_config` — refuse to boot on missing or known-weak
 * credentials. Audit finding #4: Rust panicked on `quran-ai-dev-secret` and `smoke-ml-api-key`,
 * node-api took them as defaults.
 *
 * ── Two levels, and both are needed ─────────────────────────────────────────────────────────────
 * The unit cases pin WHICH values are refused, cheaply and exhaustively. The spawn case proves the
 * function is actually WIRED to the entry point — a guard defined and never called is the failure
 * mode a table of unit tests cannot see, and the one that would have shipped here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "..", "server", "src", "main.mjs");

/** A configuration with nothing wrong with it. Each case below breaks exactly one thing. */
const STRONG = {
  JWT_SECRET: "a-jwt-secret-of-at-least-thirty-two-characters",
  REALTIME_GATEWAY_TICKET_SECRET: "a-ticket-secret-of-at-least-thirty-two-chars",
  ML_API_KEY: "a-real-ml-key",
  ASR_API_KEY: "a-real-asr-key",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
};

test("a fully configured environment has no problems", () => {
  assert.deepEqual(insecureSecretProblems({ ...STRONG }), []);
});

for (const [label, broken] of [
  ["a missing JWT secret", { JWT_SECRET: "" }],
  ["the dev JWT secret", { JWT_SECRET: "quran-ai-dev-secret" }],
  ["the placeholder JWT secret", { JWT_SECRET: "production-secret-change-me" }],
  ["a short JWT secret", { JWT_SECRET: "0123456789abcdef0123456789abcde" }], // 31
  ["the smoke ticket secret", { REALTIME_GATEWAY_TICKET_SECRET: "smoke-secret" }],
  ["a short ticket secret", { REALTIME_GATEWAY_TICKET_SECRET: "too-short" }],
  ["the smoke ML key", { ML_API_KEY: "smoke-ml-api-key" }],
  ["a missing ML key", { ML_API_KEY: "   " }],
  ["the smoke ASR key", { ASR_API_KEY: "smoke-asr-api-key" }],
  ["unset CORS origins", { CORS_ALLOWED_ORIGINS: "" }],
]) {
  test(`${label} is refused`, () => {
    const problems = insecureSecretProblems({ ...STRONG, ...broken });
    assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
    assert.match(problems[0], new RegExp(Object.keys(broken)[0]));
  });
}

test("a 32-character JWT secret is exactly long enough", () => {
  // The boundary, both sides. Rust's check is `< 32`, so 32 passes — an off-by-one here would
  // reject a configuration the upstream accepts, and the two services would disagree at boot.
  assert.deepEqual(insecureSecretProblems({ ...STRONG, JWT_SECRET: "x".repeat(32) }), []);
  assert.equal(insecureSecretProblems({ ...STRONG, JWT_SECRET: "x".repeat(31) }).length, 1);
});

test("every weak value is reported at once, not one per restart", () => {
  // An operator fixing these one boot at a time is five deploys. Rust panics on the first; this is
  // a deliberate, documented improvement over the port source, not an accident.
  const problems = insecureSecretProblems({});
  assert.equal(problems.length, 5, JSON.stringify(problems));
});

for (const relaxation of [
  { [ALLOW_INSECURE_SECRETS]: "1" },
  { [ALLOW_INSECURE_SECRETS]: "true" },
  { [LEGACY_VAR]: "1" },
  { [LEGACY_VAR]: "true" },
]) {
  test(`local dev opts out with ${JSON.stringify(relaxation)}`, () => {
    assert.deepEqual(insecureSecretProblems({ ...relaxation }), []);
  });
}

test("the legacy variable's other values do NOT relax the check", () => {
  // `LEGACY_ONE_OR_TRUE` is exactly ["1", "true"]. Anything else — including "yes" and "0" — leaves
  // the guard armed, because a typo in a relaxation flag must fail closed.
  for (const v of ["yes", "0", "TRUE", ""]) {
    assert.notEqual(insecureSecretProblems({ [LEGACY_VAR]: v }).length, 0, `${v} relaxed the guard`);
  }
});

/** Spawn the real entry point and report how it died. */
function boot(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      env: {
        PATH: process.env.PATH,
        // Set, so an exit is never the "upstream is required" refusal wearing this test's name.
        PLATFORM_API_UPSTREAM: "http://127.0.0.1:1",
        NODE_API_BIND: "127.0.0.1:0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {});
    child.once("exit", (code) => resolve({ code, stderr }));
    // A process that does NOT exit is the pass condition for the boots-fine case.
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr, stillRunning: true });
    }, 4000);
  });
}

test("the entry point refuses to boot on known-weak secrets", async () => {
  const { code, stderr } = await boot({ JWT_SECRET: "quran-ai-dev-secret" });
  assert.equal(code, 2, `expected exit 2, got ${code}. stderr:\n${stderr}`);
  assert.match(stderr, /JWT_SECRET is a known default/);
  assert.match(stderr, /platform-api refuses the same values/);
  assert.doesNotMatch(stderr, /quran-ai-dev-secret.*\n.*Server listening/i);
});

test("the entry point boots when the secrets are strong", async () => {
  const res = await boot(STRONG);
  assert.equal(res.stillRunning, true, `it exited (${res.code}) instead of listening:\n${res.stderr}`);
});

test("the entry point boots under the dev relaxation, as the harness relies on", async () => {
  // `tests/api-parity/lib/harness.mjs` BASE_ENV sets ALLOW_INSECURE_DEFAULTS=1 and a 15-character
  // JWT_SECRET. If this ever stopped being true, the whole parity suite would fail at startup with
  // a message about secrets rather than about whatever it was actually testing.
  const res = await boot({ ALLOW_INSECURE_DEFAULTS: "1", JWT_SECRET: "test-jwt-secret" });
  assert.equal(res.stillRunning, true, `it exited (${res.code}):\n${res.stderr}`);
});

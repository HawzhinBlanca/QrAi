import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_UPSTREAM_TIMEOUT_SECS,
  upstreamTimeoutMs,
} from "../../services/node-api/lib/upstream.mjs";

/**
 * The node-api port of `lib.rs` `upstream_timeout` — every ML/ASR call gets a deadline, and a value
 * the service cannot honour refuses to boot.
 *
 * ── Why this file exists instead of leaning on upstream-hang.test.mjs ──────────────────────────
 * `tests/api-parity/upstream-hang.test.mjs` already asserts both refusals. It CANNOT assert them
 * for this service. Under `PARITY_THROUGH_SHELL=1` the harness starts the Rust binary first and the
 * Node shell in front of it (harness.mjs:225), and both read the same env — so with
 * `UPSTREAM_TIMEOUT_SECS=6O` the RUST process dies during startup and `startApi` rejects before the
 * shell is ever spawned. The assertion passes, having proved nothing about the port. That is the
 * same shape as the vacuous tests found earlier in this repo: green, and measuring the wrong
 * process.
 *
 * So the boot refusals are asserted HERE, against the entry point directly. The hang and the 502
 * ARE comparable through the shell and stay in the parity file, which now runs in both passes.
 *
 * ── Two levels, per boot-guard.test.mjs ────────────────────────────────────────────────────────
 * Unit cases pin WHICH values are refused. The spawn cases prove the parser is WIRED to the entry
 * point — a guard defined and never called is what a table of unit tests cannot see.
 */

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "..", "services", "node-api", "server.mjs");

// --- the parser ---

test("an unset or empty value is the documented 60s default", () => {
  assert.equal(upstreamTimeoutMs({}), DEFAULT_UPSTREAM_TIMEOUT_SECS * 1000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: "" }), 60_000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: "   " }), 60_000);
  assert.equal(DEFAULT_UPSTREAM_TIMEOUT_SECS, 60, "lib.rs DEFAULT_UPSTREAM_TIMEOUT_SECS");
});

test("a whole number of seconds is honoured, in milliseconds", () => {
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: "3" }), 3000);
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: "1" }), 1000);
  // Rust's u64::from_str accepts a leading plus, and this is a port.
  assert.equal(upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: "+5" }), 5000);
});

for (const [raw, why] of [
  ["6O", "capital letter O — the realistic typo, and the one a fallback swallows"],
  ["5s", "a unit suffix"],
  ["5.0", "a float"],
  ["-1", "negative"],
  ["1_000", "a digit separator"],
  ["0", "reads like 'fail fast' and means the opposite"],
  [String(2 ** 31), "beyond what AbortSignal.timeout can express"],
]) {
  test(`UPSTREAM_TIMEOUT_SECS=${JSON.stringify(raw)} is refused (${why})`, () => {
    assert.throws(
      () => upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: raw }),
      /UPSTREAM_TIMEOUT_SECS/,
      "the error must name the variable, or an operator cannot fix it",
    );
  });
}

test("a refused value never silently becomes the default", () => {
  // The whole reason this parses strictly. If any branch returned 60_000 instead of throwing, an
  // operator who set 5 would be running on 60 with nothing to tell them.
  for (const raw of ["6O", "0", "-1", "abc"]) {
    let returned = "did not return";
    try {
      returned = upstreamTimeoutMs({ UPSTREAM_TIMEOUT_SECS: raw });
    } catch {
      continue;
    }
    assert.fail(`${JSON.stringify(raw)} returned ${returned} instead of throwing`);
  }
});

// --- wired to the entry point ---

/** Spawn the real entry point and report how it died. Mirrors boot-guard.test.mjs. */
function boot(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      env: {
        PATH: process.env.PATH,
        // Set, so an exit is never the "upstream is required" refusal wearing this test's name.
        PLATFORM_API_UPSTREAM: "http://127.0.0.1:1",
        NODE_API_BIND: "127.0.0.1:0",
        // Strong, so the exit we observe is the TIMEOUT guard and not the secrets guard — which
        // runs first in server.mjs and would otherwise answer in this test's name.
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
    // A process that does NOT exit is the pass condition for the boots-fine case.
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr, stillRunning: true });
    }, 4000);
  });
}

test("the entry point refuses to boot on a non-numeric UPSTREAM_TIMEOUT_SECS", async () => {
  const { code, stderr } = await boot({ UPSTREAM_TIMEOUT_SECS: "6O" });
  assert.equal(code, 2, `expected exit 2, got ${code}. stderr:\n${stderr}`);
  assert.match(stderr, /UPSTREAM_TIMEOUT_SECS must be a whole number of seconds/);
  assert.doesNotMatch(stderr, /is a known default/, "the SECRETS guard answered, not this one");
});

test("the entry point refuses UPSTREAM_TIMEOUT_SECS=0", async () => {
  const { code, stderr } = await boot({ UPSTREAM_TIMEOUT_SECS: "0" });
  assert.equal(code, 2, `expected exit 2, got ${code}. stderr:\n${stderr}`);
  assert.match(stderr, /UPSTREAM_TIMEOUT_SECS=0/);
});

test("the entry point boots on a valid timeout, and on none at all", async () => {
  // Without this the two refusals above are satisfied by a service that never boots for any reason.
  for (const env of [{ UPSTREAM_TIMEOUT_SECS: "3" }, {}]) {
    const res = await boot(env);
    assert.equal(
      res.stillRunning,
      true,
      `it exited (${res.code}) with ${JSON.stringify(env)} instead of listening:\n${res.stderr}`,
    );
  }
});

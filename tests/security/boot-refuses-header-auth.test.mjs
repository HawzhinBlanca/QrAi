import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The platform API refuses to start with the spoofable-header identity fallback enabled.
 *
 * ── What ALLOW_HEADER_AUTH does ─────────────────────────────────────────────────────────────────
 * It makes `x-tenant-id`, `x-user-id` and `x-user-role` — headers any client can set — an accepted
 * identity (`services/platform-api/src/auth.rs:114`). Any caller could name any tenant, any user
 * and any role. It is the single switch that collapses the whole authentication boundary.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────────
 * Its BEHAVIOUR was already well covered: `tests/api-parity/auth-disabled.test.mjs` runs the suite
 * with it off, and the `header-auth-on` mutation in the parity harness proves those tests have
 * teeth. What nothing covered was a DEPLOY THAT SIMPLY HAS IT ON. Every comparable control —
 * `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`, `ML_API_KEY`, `ASR_API_KEY`,
 * `CORS_ALLOWED_ORIGINS` — fails closed in `ensure_secure_config`; this one did not, which made it
 * the only prod-critical control in the service with no boot-time refusal.
 *
 * ── Why this runs the real binary ───────────────────────────────────────────────────────────────
 * `insecure::header_auth_refusal` is unit-tested in Rust, but a pure function returning the right
 * string proves nothing about whether `main` consults it. The claim here is that the PROCESS stops.
 * `ensure_secure_config()` is the second statement in `main`, before any database connection, so
 * this needs no Postgres.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary =
  process.env.PARITY_API_BIN ?? join(root, "services/platform-api/target/debug/quran-ai-platform-api");

/** Values strong enough to clear every OTHER boot check, so a failure here is about header auth. */
const STRONG = {
  JWT_SECRET: "a-strong-jwt-secret-for-boot-tests-0123456789",
  REALTIME_GATEWAY_TICKET_SECRET: "a-strong-ticket-secret-for-boot-tests-0123456789",
  ML_API_KEY: "boot-test-ml-key",
  ASR_API_KEY: "boot-test-asr-key",
  CORS_ALLOWED_ORIGINS: "https://boot-test.invalid",
  // A port nothing listens on: if the process gets past the config checks it dies on the database,
  // which is the outcome the control below wants.
  DATABASE_URL: "postgresql://unused@127.0.0.1:1/none",
  RUST_LOG: "error",
};

function boot(extraEnv) {
  const result = spawnSync(binary, [], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...STRONG, ...extraEnv },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const REFUSAL = /ALLOW_HEADER_AUTH is enabled/;

test("refuses to boot when ALLOW_HEADER_AUTH is on and nothing has relaxed the posture", (t) => {
  if (!existsSync(binary)) {
    // Skipped loudly rather than passed quietly: `cargo test` builds this binary, so an absent one
    // means the Rust suite has not run, not that the guard is fine.
    t.skip(`platform-api binary not built at ${binary} — run cargo test first`);
    return;
  }

  const output = boot({ ALLOW_HEADER_AUTH: "1" });
  assert.match(
    output,
    REFUSAL,
    `the service started with client-supplied headers accepted as identity:\n${output}`,
  );
  // The message must tell an operator what it actually does, and name the escape hatch, or a
  // deploy stops with no way to act on it.
  assert.match(output, /x-user-role/, output);
  assert.match(output, /ALLOW_INSECURE_SECRETS/, output);
});

test("boots past the config checks when ALLOW_HEADER_AUTH is absent", (t) => {
  if (!existsSync(binary)) {
    t.skip(`platform-api binary not built at ${binary}`);
    return;
  }

  // The control. Without it the assertion above is satisfied by a binary that refuses to start for
  // any reason at all. This one gets past every config check and dies on the unreachable database.
  const output = boot({});
  assert.doesNotMatch(output, REFUSAL, `refused for header auth when the variable was not set:\n${output}`);
});

test("dev and CI are unaffected — the relax path still boots", (t) => {
  if (!existsSync(binary)) {
    t.skip(`platform-api binary not built at ${binary}`);
    return;
  }

  // tests/api-parity/lib/harness.mjs BASE_ENV sets ALLOW_INSECURE_DEFAULTS=1 alongside
  // ALLOW_HEADER_AUTH=1 for EVERY parity group. If this refused, the whole parity suite would stop
  // booting — which is exactly why the variable was not added to insecure.rs SPECIFIC_VARS.
  const output = boot({ ALLOW_HEADER_AUTH: "1", ALLOW_INSECURE_DEFAULTS: "1" });
  assert.doesNotMatch(output, REFUSAL, `the documented dev/CI path was refused:\n${output}`);
});

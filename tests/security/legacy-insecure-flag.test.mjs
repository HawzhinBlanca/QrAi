import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * S4 — the repo-level half of the deprecation.
 * specs/insecure-defaults-split/plan.md §3.4
 *
 * ── What this gate can and cannot do ───────────────────────────────────────────────────────────
 * `migration/plan.md §2.6` asked for "a boot assertion that ALLOW_INSECURE_DEFAULTS is never set in
 * production". Neither Rust service knows what environment it is in — there is no APP_ENV anywhere
 * under services/ — and inventing one to find out is the same mistake in a new costume.
 *
 * So this checks the only thing a repo CAN check: that no committed production-shaped artifact
 * ships a relaxation switched ON. **It cannot catch an operator exporting the variable by hand.**
 * That ceiling is real, it is stated in plan.md §3.4 and in both insecure.rs modules, and this
 * comment exists so nobody reads a green tick here as "production is safe".
 *
 * Hermetic: reads committed files, runs no processes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/**
 * Relaxations that have NO legitimate production use. Each one, switched on, disables a control
 * that exists because turning it off is dangerous.
 *
 * GATEWAY_ALLOW_MISSING_ORIGIN is deliberately ABSENT: accepting a WebSocket upgrade with no Origin
 * header is exactly what a native/Flutter client needs, and it keeps the allowlist enforced for
 * browsers (plan.md §3.2). Listing it here would gate the one use case the split was built to
 * enable.
 */
const NEVER_IN_PRODUCTION = [
  "ALLOW_INSECURE_DEFAULTS",
  "ALLOW_INSECURE_SECRETS",
  "ALLOW_SUPERUSER_DB_ROLE",
  "METRICS_DEV_OPEN",
  "ALLOW_CHAOS_INJECTION",
];

/**
 * Artifacts that describe a PRODUCTION or staging deployment.
 *
 * `.github/workflows/ci.yml` and `docs/TESTING.md` set ALLOW_INSECURE_DEFAULTS=1 and are correctly
 * absent — CI runs against a superuser DATABASE_URL and throwaway secrets, which is what the flag is
 * for. Gating them would be gating dev, not production.
 */
const PRODUCTION_ARTIFACTS = [
  "docker-compose.yml",
  "scripts/gen-production-secrets.sh",
  "scripts/recreate-staging.sh",
];

const TRUTHY = new Set(["1", "true"]);

/**
 * The committed DEFAULT of an assignment — the only thing a static gate can see.
 *
 * `"${FOO:-0}"` is a passthrough with a secure default and is fine; `"${FOO:-1}"` and a bare `1`
 * are not. Exported so the parsing itself is pinned below rather than trusted.
 */
export function committedDefault(rhs) {
  const passthrough = rhs.match(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/);
  return (passthrough ? passthrough[1] : rhs).replace(/["']/g, "").trim();
}

/** Every `NAME=value` / `NAME: value` assignment of `name` in `source`, as committed defaults. */
export function assignedDefaults(source, name) {
  const found = [];
  for (const line of source.split("\n")) {
    // Assignment lines may be YAML keys or shell assignments/exports. Anchor the entire prefix so
    // a prose comment containing `NAME=...` cannot inflate a security-control coverage count.
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*[:=]\\s*(.*)$`));
    if (match) found.push({ line: line.trim(), value: committedDefault(match[1]) });
  }
  return found;
}

// --- the gate ---

test("no production artifact ships a security relaxation switched ON", () => {
  const violations = [];
  for (const artifact of PRODUCTION_ARTIFACTS) {
    const source = read(artifact);
    for (const name of NEVER_IN_PRODUCTION) {
      for (const { line, value } of assignedDefaults(source, name)) {
        if (TRUTHY.has(value)) violations.push(`${artifact}: ${line}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `these committed defaults disable a security control in a production-shaped artifact:\n  ${violations.join("\n  ")}`,
  );
});

test("the deprecated single switch is read ONLY through insecure.rs", () => {
  // The split is undone the moment someone adds `std::env::var("ALLOW_INSECURE_DEFAULTS")` back to
  // a handler. Cheap to check, and it is the regression that would otherwise be invisible.
  const rustSources = ["services/platform-api/src", "services/realtime-gateway/src"].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".rs") && f !== "insecure.rs")
      .map((f) => join(dir, f)),
  );
  // `env::var(`, not `var(`: `std::env::set_var("ALLOW_INSECURE_DEFAULTS", …)` ends in `var(` too,
  // and the origin tests legitimately SET it to prove the alias still works. Only READS have to
  // route through insecure.rs. The first version of this line flagged lib.rs for exactly that.
  const offenders = rustSources.filter((rel) =>
    read(rel).includes('env::var("ALLOW_INSECURE_DEFAULTS")'),
  );
  assert.deepEqual(
    offenders,
    [],
    `these read the deprecated variable directly instead of going through insecure.rs:\n  ${offenders.join("\n  ")}\n` +
      `Use insecure::relaxed(insecure::<SPECIFIC_VAR>) so the control has its own name.`,
  );
});

test("both services expose the same deprecated alias name", () => {
  // Two hand-maintained copies (plan.md §3, impact-map §2). If they drift on the LEGACY_VAR name,
  // one service silently stops honouring an operator's existing config.
  const named = ["services/platform-api/src/insecure.rs", "services/realtime-gateway/src/insecure.rs"].map(
    (rel) => read(rel).match(/LEGACY_VAR: &str = "([^"]+)"/)?.[1],
  );
  assert.deepEqual(named, ["ALLOW_INSECURE_DEFAULTS", "ALLOW_INSECURE_DEFAULTS"]);
});

// --- the parsing this gate rests on, pinned rather than trusted ---

test("committedDefault reads through a shell default-expansion", () => {
  assert.equal(committedDefault('"${ALLOW_INSECURE_DEFAULTS:-0}"'), "0");
  assert.equal(committedDefault('"${ALLOW_INSECURE_DEFAULTS:-1}"'), "1");
  assert.equal(committedDefault('"1"'), "1");
  assert.equal(committedDefault("0"), "0");
  assert.equal(committedDefault('"${ALLOW_INSECURE_DEFAULTS:-}"'), "");
});

test("assignedDefaults finds assignments and ignores mentions", () => {
  // The failure mode that makes a gate decorative: matching nothing and passing. Both directions
  // are asserted, because a pattern that cannot match is indistinguishable from a clean repo.
  const yaml = '      ALLOW_INSECURE_DEFAULTS: "${ALLOW_INSECURE_DEFAULTS:-1}"';
  assert.deepEqual(
    assignedDefaults(yaml, "ALLOW_INSECURE_DEFAULTS").map((f) => f.value),
    ["1"],
  );
  assert.deepEqual(assignedDefaults("# do not set ALLOW_INSECURE_DEFAULTS in prod", "ALLOW_INSECURE_DEFAULTS"), []);
  assert.deepEqual(assignedDefaults("# use ALLOW_INSECURE_DEFAULTS=1 only in dev", "ALLOW_INSECURE_DEFAULTS"), []);
  assert.deepEqual(assignedDefaults("echo ${ALLOW_INSECURE_DEFAULTS}", "ALLOW_INSECURE_DEFAULTS"), []);
  // A near-miss name must not match, or the gate reports the wrong variable.
  assert.deepEqual(assignedDefaults("EXTRA_ALLOW_INSECURE_DEFAULTS=1", "ALLOW_INSECURE_DEFAULTS"), []);
});

// --- the native-client overlay ---
//
// GATEWAY_ALLOW_MISSING_ORIGIN is exempt from NEVER_IN_PRODUCTION (see that list's comment): it is
// the switch the insecure-defaults split was built to enable. These two tests pin the shape of that
// exemption, because "legitimate in production" and "on everywhere" are different claims.

test("the native overlay actually enables the native switch", () => {
  // Without this the overlay is a no-op file and every recitation from apps/flutter 403s, which is
  // precisely the bug it was added to fix. A gate that cannot fail is decorative.
  const found = assignedDefaults(read("docker-compose.native.yml"), "GATEWAY_ALLOW_MISSING_ORIGIN");
  assert.equal(
    found.length,
    2,
    "the native switch must cover exactly the deployed Rust and Node realtime roles",
  );
  assert.deepEqual(
    found.filter((f) => !TRUTHY.has(f.value)),
    [],
    "the overlay assigns the switch a value that does not enable it",
  );
});

test("the base stack still fails closed on a missing Origin", () => {
  // The base serves the browser app and nothing else, so no legitimate client omits Origin there.
  // If this ever flips to a truthy default, the browser-only deployment silently starts accepting
  // no-Origin WebSocket upgrades and the overlay stops meaning anything.
  const found = assignedDefaults(read("docker-compose.yml"), "GATEWAY_ALLOW_MISSING_ORIGIN");
  assert.equal(found.length, 2, "both realtime admission roles must declare the strict base default");
  for (const { line, value } of found) {
    assert.ok(
      !TRUTHY.has(value),
      `docker-compose.yml enables the native switch by default; it belongs in docker-compose.native.yml:\n  ${line}`,
    );
  }
});

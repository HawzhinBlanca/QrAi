import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every reason a finding can be withheld from a learner must have a test that withholds it. (P3.2)
 *
 * `canShowLearnerFacingAiOutput` is one boolean with three independent ways to be false, and each
 * one protects against a different mistake:
 *
 *   status      — a human has not looked at this
 *   confidence  — the model itself is unsure
 *   sources     — nothing backs the claim up
 *
 * A test suite can cover the gate thoroughly and still cover only ONE of those, because any single
 * failing condition produces the same `false`. The others are then free to regress: change the
 * confidence floor comparison and the status tests still pass.
 *
 * The fourth reason, `expired`, is NOT covered and must not appear covered. There is no expiry
 * concept for an approval anywhere in the schema, and inventing one is a scholar/product ruling —
 * ADR-0042. This file lists it as deliberately absent with a pointer to that decision, so it stays
 * visible instead of being quietly forgotten or quietly implemented.
 *
 * Hermetic: reads the contract and the test tree.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT = join(root, "packages/contracts/src/index.ts");

/**
 * The reasons the gate can refuse, and how a test claims to exercise each.
 *
 * Derived from the gate's own source below, not hand-listed: `assertGateStillHasThreeConditions`
 * fails if the implementation grows or loses a condition, which is what would make this list stale.
 */
const REASONS = [
  { id: "unreviewed-status", marker: "@withheld: unreviewed-status" },
  { id: "below-confidence-floor", marker: "@withheld: below-confidence-floor" },
  { id: "no-sources", marker: "@withheld: no-sources" },
];

/** Named, unclaimed, and deliberately so. */
const DEFERRED = [{ id: "expired", why: "ADR-0042 — no expiry concept exists; needs a ruling" }];

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "target", "dist"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(mjs|ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function claims() {
  const found = new Map();
  const roots = [join(root, "tests"), join(root, "packages/contracts"), join(root, "apps/web/src")];
  for (const dir of roots) {
    for (const file of sources(dir)) {
      // Skip this file. It contains every marker string as data, so scanning itself made the
      // coverage assertion pass with ZERO real annotations — the guard certifying its own health.
      // Caught on the first run: all four tests green before a single test had been annotated.
      if (file === fileURLToPath(import.meta.url)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/@withheld:\s*([a-z0-9-]+)/g)) {
        const key = m[1];
        if (!found.has(key)) found.set(key, []);
        found.get(key).push(file.slice(root.length + 1));
      }
    }
  }
  return found;
}

test("the gate still has exactly the three conditions this file tracks", () => {
  // The reason REASONS is not simply a hand-maintained list. If a fourth condition is added to the
  // gate — a new status, a provenance check, an expiry — this fails, and whoever added it has to
  // decide what test covers it rather than inheriting silent coverage.
  const src = readFileSync(CONTRACT, "utf8");
  const fn = src.slice(src.indexOf("export function canShowLearnerFacingAiOutput"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.length > 0, "canShowLearnerFacingAiOutput is gone from the contract");

  assert.match(body, /reviewStatus === "teacher-reviewed"/, "the status condition changed shape");
  assert.match(body, /reviewStatus === "scholar-approved"/, "the approved-status allowlist changed");
  assert.match(body, /confidence >= 0\.82/, "the confidence floor changed — is a test still pinning it?");
  assert.match(body, /sources\.length > 0/, "the sources condition changed shape");

  // Nothing else may decide the outcome. A fourth `return` would be a condition this file does not
  // know about, and every assertion below would keep passing while it went untested.
  const returns = body.match(/return\s/g) ?? [];
  assert.equal(
    returns.length,
    2,
    `the gate has ${returns.length} return statements; this file is written for 2 (the early ` +
      `status refusal and the combined confidence/sources answer). A new branch needs a new reason ` +
      `in REASONS and a test that exercises it.`,
  );
});

test("every reason the gate can refuse for has a test that exercises it", () => {
  const found = claims();
  const missing = REASONS.filter((r) => !found.has(r.id)).map(
    (r) => `${r.id} — annotate the test that proves it with "${r.marker}"`,
  );
  assert.deepEqual(
    missing,
    [],
    `a learner can be withheld feedback for these reasons and nothing proves it:\n  ` +
      `${missing.join("\n  ")}\n` +
      `Any one failing condition produces the same false, so untested conditions regress silently.`,
  );
});

test("the deferred reason is still deferred, and still named", () => {
  // Both directions. If `expired` acquires a test, this file must be updated rather than the test
  // quietly implementing a ruling nobody made; if it loses its entry here, the gap stops being
  // visible. ADR-0042 is the decision that resolves it.
  const found = claims();
  for (const { id, why } of DEFERRED) {
    assert.ok(
      !found.has(id),
      `"${id}" now has a test (${found.get(id)?.join(", ")}), but it is recorded here as deferred: ` +
        `${why}. If the ruling has been made, update ADR-0042 and move it into REASONS.`,
    );
  }

  const adrs = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  assert.match(
    adrs,
    /## ADR-0042 —/,
    "ADR-0042 is gone, so the deferred `expired` reason has no recorded reason for being deferred",
  );
  assert.match(
    adrs.slice(adrs.indexOf("## ADR-0042 —")),
    /\*\*Status:\*\* Proposed/,
    "ADR-0042 is no longer Proposed — if it has been decided, `expired` needs a test, not a deferral",
  );
});

test("no annotation claims a reason the gate does not have", () => {
  const known = new Set([...REASONS.map((r) => r.id), ...DEFERRED.map((d) => d.id)]);
  const orphans = [];
  for (const [id, files] of claims()) {
    if (!known.has(id)) orphans.push(`${id} — claimed by ${files.join(", ")}`);
  }
  assert.deepEqual(orphans, [], `withheld annotations naming no known reason:\n  ${orphans.join("\n  ")}`);
});

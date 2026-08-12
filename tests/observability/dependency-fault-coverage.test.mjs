import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every dependency whose failure behavior the project has PUBLISHED must have a test that makes it
 * fail. (P5.3)
 *
 * P5.2 is ticked and it produced a real artifact: the per-dependency timeout / retry / degradation
 * table in `docs/readiness/INVENTORIES.md`. Five dependencies, each with three published claims
 * about what happens when it breaks — a pool that cannot be acquired returns a retryable 503, an ML
 * timeout degrades to a 502 that leaks no internal URL, a dropped socket reconnects with jitter and
 * flushes its buffer in order, the kill switch 503s everything but the probes.
 *
 * Nothing tested any of it. The table was written from reading the code, which is exactly the
 * failure mode this repo keeps finding: a claim derived from the same source it is supposed to
 * check. A dependency could change its degradation tomorrow and the document would still say the
 * old thing, confidently, in a row someone already ticked.
 *
 * So: list A is the table. List B is the tests that annotate themselves `@fault-coverage: <slug>`.
 * The annotation lives in the TEST, not in a list here — a manifest inside this file would be a pin
 * on today's state maintained by the same hand that writes the tests. Add a dependency to the map
 * and this fails until something proves how it degrades.
 *
 * Hermetic: reads a markdown file and a directory of sources. Starts nothing.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INVENTORIES = join(root, "docs/readiness/INVENTORIES.md");

/** `**platform-api** (from web)` -> `platform-api`; `ML / ASR` -> `ml-asr`. */
export function slug(name) {
  return name
    .replace(/\*\*/g, "")
    .replace(/\(.*\)/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The dependency column of the P5.2 table. */
function mappedDependencies() {
  const md = readFileSync(INVENTORIES, "utf8");
  // `\b` matters: without it this also matches a future `## P5.2b`, silently parsing the wrong
  // section instead of failing. Found while negative-controlling this very check.
  const section = md.split(/^## P5\.2\b[^\n]*$/m)[1];
  assert.ok(section, "the P5.2 section is gone from INVENTORIES.md — has the map moved?");

  const deps = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1]?.trim();
    if (!first) continue;
    if (/^-+$/.test(first.replace(/[|: -]/g, "-").replace(/-+/, "-"))) continue; // separator row
    if (first === "Dependency") continue; // header
    if (!first.includes("**")) continue; // the table bolds every dependency name
    deps.push({ name: first, slug: slug(first) });
  }
  return deps;
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "target", "dist"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (entry.endsWith(".mjs") || entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** slug -> the test files claiming to cover that dependency's failure behavior. */
function faultCoverage() {
  const covered = new Map();
  for (const file of sources(join(root, "tests")).concat(sources(join(root, "apps/web/src/lib")))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/@fault-coverage:\s*([a-z0-9-]+)/g)) {
      const key = m[1];
      if (!covered.has(key)) covered.set(key, []);
      covered.get(key).push(file.slice(root.length + 1));
    }
  }
  return covered;
}

test("the P5.2 dependency map is still a table this can read", () => {
  // Without this, a reformatted document silently yields zero dependencies and the coverage
  // assertion below passes over an empty set — reporting that every dependency is fault-tested
  // when none is.
  const deps = mappedDependencies();
  assert.ok(
    deps.length >= 5,
    `parsed only ${deps.length} dependencies out of the P5.2 map — expected at least 5. ` +
      `If the table was reformatted, fix this parser; do not delete the check.`,
  );
});

test("every dependency in the P5.2 map has a fault test", () => {
  const covered = faultCoverage();
  const uncovered = mappedDependencies()
    .filter((d) => !covered.has(d.slug))
    .map((d) => `${d.name.replace(/\*\*/g, "")}  (annotate a test "@fault-coverage: ${d.slug}")`);

  assert.deepEqual(
    uncovered,
    [],
    `these dependencies publish a degradation behavior in docs/readiness/INVENTORIES.md that ` +
      `nothing tests:\n  ${uncovered.join("\n  ")}\n` +
      `A documented failure mode with no test is a claim, not a control.`,
  );
});

test("no fault annotation names a dependency that is not in the map", () => {
  // The reverse direction: a test annotated for a dependency that was renamed or removed from the
  // map still counts as coverage of nothing, and would mask the real gap.
  const mapped = new Set(mappedDependencies().map((d) => d.slug));
  const orphans = [];
  for (const [key, files] of faultCoverage()) {
    if (!mapped.has(key)) orphans.push(`${key} — claimed by ${files.join(", ")}`);
  }
  assert.deepEqual(
    orphans,
    [],
    `fault annotations naming no dependency in the P5.2 map:\n  ${orphans.join("\n  ")}`,
  );
});

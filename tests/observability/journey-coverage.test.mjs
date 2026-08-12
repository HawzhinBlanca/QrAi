import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every critical journey this project names must have a test that walks it. (P6.1)
 *
 * Before `docs/readiness/JOURNEYS.md`, no document said what a critical journey WAS, so "create
 * end-to-end tests for learner, teacher, reviewer, approval, and privacy paths" could be neither
 * satisfied nor refuted — and exactly one journey test existed, for privacy. The row could have sat
 * open or been ticked and nobody could have said which was right.
 *
 * Same construction as `dependency-fault-coverage.test.mjs`: list A is the table in JOURNEYS.md,
 * list B is the tests that claim a journey with `@journey: <id>`. The claim lives in the test, so
 * this file cannot drift into being a hand-maintained list of what someone believes is covered.
 *
 * Hermetic: reads a markdown file and a directory of sources.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JOURNEYS = join(root, "docs/readiness/JOURNEYS.md");

/** The `id` column of the journeys table — the backticked key in each row's first cell. */
function namedJourneys() {
  const md = readFileSync(JOURNEYS, "utf8");
  const section = md.split(/^## The journeys\b[^\n]*$/m)[1];
  assert.ok(section, "the journeys table is gone from JOURNEYS.md");

  const ids = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1]?.trim();
    const m = /^`([a-z0-9-]+)`$/.exec(cell ?? "");
    if (m) ids.push(m[1]);
    if (line.startsWith("## ")) break;
  }
  return ids;
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "target", "dist"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (entry.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/** id -> the test files claiming to walk that journey. */
function journeyCoverage() {
  const covered = new Map();
  for (const file of sources(join(root, "tests"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/@journey:\s*([a-z0-9-]+)/g)) {
      const key = m[1];
      if (!covered.has(key)) covered.set(key, []);
      covered.get(key).push(file.slice(root.length + 1));
    }
  }
  return covered;
}

test("the journeys table is still a table this can read", () => {
  // Non-vacuity: a reformatted document must fail loudly here rather than yielding zero journeys
  // and letting every assertion below pass over an empty set.
  const ids = namedJourneys();
  assert.ok(
    ids.length >= 5,
    `parsed only ${ids.length} journeys out of JOURNEYS.md — expected at least 5. ` +
      `If the table changed shape, fix this parser; do not delete the check.`,
  );
  assert.equal(new Set(ids).size, ids.length, `duplicate journey ids: ${ids.join(", ")}`);
});

test("every named journey has an end-to-end test", () => {
  const covered = journeyCoverage();
  const missing = namedJourneys()
    .filter((id) => !covered.has(id))
    .map((id) => `${id}  (annotate a test "@journey: ${id}")`);

  assert.deepEqual(
    missing,
    [],
    `these journeys are named as critical in docs/readiness/JOURNEYS.md and nothing walks them ` +
      `end to end:\n  ${missing.join("\n  ")}`,
  );
});

test("no test claims a journey the document does not name", () => {
  const named = new Set(namedJourneys());
  const orphans = [];
  for (const [id, files] of journeyCoverage()) {
    if (!named.has(id)) orphans.push(`${id} — claimed by ${files.join(", ")}`);
  }
  assert.deepEqual(
    orphans,
    [],
    `journey claims naming nothing in JOURNEYS.md:\n  ${orphans.join("\n  ")}`,
  );
});

test("the severity policy still defines all three levels", () => {
  // The journeys are only half of P6.1; the row also asks for a severity/blocker policy. A table of
  // journeys with no severity scale would satisfy the checks above and leave the other half absent.
  const md = readFileSync(JOURNEYS, "utf8");
  for (const level of ["sev-1", "sev-2", "sev-3"]) {
    assert.ok(
      new RegExp(`\\*\\*${level}\\*\\*`).test(md),
      `the severity policy no longer defines ${level}`,
    );
  }
  assert.match(md, /Blocks release/, "sev-1 must still state what it blocks");
  assert.match(md, /Blocks pilot/, "sev-2 must still state what it blocks");
});

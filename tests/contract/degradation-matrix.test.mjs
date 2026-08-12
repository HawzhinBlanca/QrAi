import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every degraded state this project claims to handle must cite a test that EXISTS and RUNS. (P2.6)
 *
 * "Specify/test actionable unavailable/loading/offline/permission/timeout states for every critical
 * flow" could not be checked because nothing enumerated the cells. Some were handled, some were not,
 * and there was no way to tell which — which is how `TeacherSurface` came to report an unreachable
 * service as "No pending recitations." for as long as it did.
 *
 * The second list here is deliberately stronger than "the file exists". A test that exists but is
 * not in `scripts/verify.sh` is a test nobody runs, and citing one would be worse than citing
 * nothing: the matrix would say the cell is covered and no gate would ever disagree. So the check is
 * cited-file ∈ files-the-gate-runs.
 *
 * `n/a` is allowed and is not an escape hatch: it must carry a reason, and the reason has to be long
 * enough to be an actual argument. Several cells genuinely are not applicable — a per-surface copy of
 * the app-shell offline banner would test the shell twice and the surface not at all — and forcing a
 * fake test into those cells would be the same dishonesty pointing the other way.
 *
 * Hermetic: reads two files.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATRIX = join(root, "docs/readiness/DEGRADED_STATES.md");

const STATES = ["unavailable", "loading", "offline", "permission-denied", "timeout"];
/** Long enough that "n/a — no" cannot pass for an argument. */
const MIN_REASON = 40;

function cells() {
  const md = readFileSync(MATRIX, "utf8");
  const section = md.split(/^## The matrix\b[^\n]*$/m)[1];
  assert.ok(section, "the matrix table is gone from DEGRADED_STATES.md");

  const rows = [];
  for (const line of section.split("\n")) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    // | flow | state | evidence |  ->  ["", flow, state, evidence, ""]
    if (parts.length < 5) continue;
    const [, flow, state, evidence] = parts;
    if (flow === "flow" || /^-+$/.test(flow)) continue;
    rows.push({ flow, state, evidence });
  }
  return rows;
}

/** Every test path `scripts/verify.sh` actually names. */
function testsTheGateRuns() {
  const sh = readFileSync(join(root, "scripts/verify.sh"), "utf8");
  const named = new Set();
  for (const m of sh.matchAll(/[A-Za-z0-9_@./-]+\.(?:test|spec)\.(?:mjs|ts|tsx)/g)) named.add(m[0]);
  return { named, sh };
}

test("the matrix is still a table this can read", () => {
  // Non-vacuity. A reformatted document must fail here rather than yielding zero cells and letting
  // every assertion below pass over an empty set.
  const rows = cells();
  assert.ok(
    rows.length >= 15,
    `parsed only ${rows.length} cells out of DEGRADED_STATES.md — expected at least 15 ` +
      `(3 flows x 5 states). If the table changed shape, fix this parser; do not delete the check.`,
  );
});

test("every flow in the matrix covers all five states, exactly once each", () => {
  // A flow that quietly omits a state is the same gap the matrix exists to close, just moved into
  // the document.
  const byFlow = new Map();
  for (const { flow, state } of cells()) {
    if (!byFlow.has(flow)) byFlow.set(flow, []);
    byFlow.get(flow).push(state);
  }
  assert.ok(byFlow.size >= 3, `only ${byFlow.size} flow(s) in the matrix`);

  const problems = [];
  for (const [flow, states] of byFlow) {
    for (const state of STATES) {
      const seen = states.filter((s) => s === state).length;
      if (seen === 0) problems.push(`${flow}: no row for "${state}"`);
      if (seen > 1) problems.push(`${flow}: "${state}" appears ${seen} times`);
    }
    for (const state of states) {
      if (!STATES.includes(state)) problems.push(`${flow}: "${state}" is not one of the five states`);
    }
  }
  assert.deepEqual(problems, [], `matrix rows:\n  ${problems.join("\n  ")}`);
});

test("every cited test exists on disk", () => {
  const missing = [];
  for (const { flow, state, evidence } of cells()) {
    if (evidence.startsWith("n/a")) continue;
    const path = evidence.replace(/`/g, "").trim();
    if (!existsSync(join(root, path))) missing.push(`${flow}/${state} cites ${path}, which is not there`);
  }
  assert.deepEqual(missing, [], `matrix cells citing a test that does not exist:\n  ${missing.join("\n  ")}`);
});

test("every cited test is one the gate actually runs", () => {
  // The assertion that makes this more than a documentation lint. A test nobody runs is a claim, and
  // citing one would let the matrix report coverage that no gate could ever contradict.
  const { named } = testsTheGateRuns();
  assert.ok(named.size > 20, `only ${named.size} test files found in verify.sh — did the gate change shape?`);

  const unrun = [];
  for (const { flow, state, evidence } of cells()) {
    if (evidence.startsWith("n/a")) continue;
    const path = evidence.replace(/`/g, "").trim();
    // Web tests are run as a suite (`pnpm --filter @quran-ai/web test`) rather than named one by
    // one, so a path under apps/web counts if the web suite runs at all.
    if (path.startsWith("apps/web/")) continue;
    if (![...named].some((n) => path.endsWith(n) || n.endsWith(path))) {
      unrun.push(`${flow}/${state} cites ${path}, which scripts/verify.sh never runs`);
    }
  }
  assert.deepEqual(unrun, [], `matrix cells citing a test the gate does not run:\n  ${unrun.join("\n  ")}`);
});

test("the web suite the matrix leans on is actually in the gate", () => {
  // The exemption above is load-bearing: most cited tests are vitest files run as a suite. If that
  // suite ever stops running, twelve cells would silently become unproven and the check above would
  // still pass. This is the assertion that stops that.
  const { sh } = testsTheGateRuns();
  assert.match(
    sh,
    /--filter @quran-ai\/web test/,
    "scripts/verify.sh no longer runs the web test suite — every apps/web cell in the matrix is " +
      "now unproven, including the one exempted from the per-file check above",
  );
});

test("an n/a cell gives a reason worth reading", () => {
  const thin = [];
  for (const { flow, state, evidence } of cells()) {
    if (!evidence.startsWith("n/a")) continue;
    const reason = evidence.replace(/^n\/a\s*[—-]?\s*/, "").trim();
    if (reason.length < MIN_REASON) {
      thin.push(`${flow}/${state}: "${reason}" (${reason.length} chars, need ${MIN_REASON})`);
    }
  }
  assert.deepEqual(
    thin,
    [],
    `n/a cells whose reason is too short to be an argument:\n  ${thin.join("\n  ")}\n` +
      `"Not applicable" without a reason is an untested cell wearing a different label.`,
  );
});

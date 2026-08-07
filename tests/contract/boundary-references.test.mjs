import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CU3 — every path `specs/cutover/boundary.md` cites must exist.
 * specs/cutover/plan.md
 *
 * A security-review package whose claims cannot be checked is worse than none, because it reads as
 * assurance. This stops it rotting into citing tests and evidence files that were deleted or renamed
 * — the reviewer would have no way to tell which claims had quietly stopped being true.
 *
 * Hermetic: file existence only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const doc = readFileSync(join(repoRoot, "specs/cutover/boundary.md"), "utf8");

/** Repo-relative paths written in backticks — the only form the document uses for evidence. */
function citedPaths(text) {
  const paths = new Set();
  for (const m of text.matchAll(/`([a-zA-Z0-9_./-]+\.(?:mjs|ts|rs|json|md|txt|yaml|sh))`/g)) {
    // Bare filenames without a directory are prose ("lib.rs:86"), not citations.
    if (m[1].includes("/")) paths.add(m[1]);
  }
  return [...paths];
}

test("boundary.md cites at least a dozen concrete artefacts", () => {
  // A review package with no citations would trivially pass the test below.
  assert.ok(
    citedPaths(doc).length >= 12,
    `only ${citedPaths(doc).length} cited paths — the package is meant to be evidence-linked`,
  );
});

test("every file boundary.md cites actually exists", () => {
  const missing = citedPaths(doc).filter((p) => !existsSync(join(repoRoot, p)));
  assert.deepEqual(
    missing,
    [],
    `boundary.md cites files that do not exist:\n  ${missing.join("\n  ")}\n` +
      `Either restore them or correct the document — a stale citation reads as assurance.`,
  );
});

test("boundary.md states the gaps, not only the evidence", () => {
  // The failure mode for a document like this is becoming a sales pitch. These are the specific
  // unresolved items a reviewer must see; losing any of them should fail rather than pass quietly.
  for (const required of [
    "ALLOW_INSECURE_DEFAULTS",
    "x-unvalidated",
    "ADR-0022",
    "no fixture and no parity test",
    "Delegation is compatibility-only",
  ]) {
    assert.ok(doc.includes(required), `boundary.md must still disclose: ${required}`);
  }
});

test("boundary.md does not claim anything is deployed", () => {
  assert.match(
    doc,
    /Nothing described here is deployed/,
    "the package must open by saying the boundary is not live",
  );
  assert.match(doc, /\*\*41 executable routes\*\*/, "it must state the standalone route count");
  assert.match(doc, /\*\*2 routes locally\*\*/, "it must state the deployed shadow route count");
});

test("a refusal is presented as a legitimate outcome", () => {
  // If signing were the only outcome the document contemplates, it would be applying pressure rather
  // than presenting evidence.
  assert.match(doc, /refusal is a legitimate outcome/i);
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MET, checkAdr0022, checkSchemaValidation } from "../../scripts/cutover-readiness.mjs";
import { loadOpenapi, routePairsFromRust } from "./lib/openapi.mjs";

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
    "delegated, not ported",
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
  assert.match(doc, /serves \*\*0 of \d+\*\*/, "it must state the served-route count");
});

/**
 * The COUNTS, derived — not pinned.
 *
 * This test used to assert the literal string `serves **0 of 38**`. That is the same rot the rest of
 * this file guards against, wearing the costume of a guard: the route total reached 40 and the pin
 * kept the stale number FROZEN, failing if anyone corrected the document. Three more claims had gone
 * stale beside it, all in §5, all understating the work — 8 uncovered pairs (now 0), 15
 * x-unvalidated operations (now 3), and "No rollback artifact. ADR-0022 is Proposed" (it is Accepted
 * and an image build exists).
 *
 * A reviewer is being asked to SIGN this. One number they can falsify discredits every other claim
 * in it, and the understating direction is not the safe one — it invites a signature on the belief
 * that gaps remain open which are in fact closed, so the signer is not reasoning about the real
 * system. So the numbers are checked against the same computation `scripts/cutover-readiness.mjs`
 * prints, exactly as the cited PATHS are checked against the filesystem.
 */
test("every route total in boundary.md is the number the repo actually has", () => {
  const total = routePairsFromRust(
    readFileSync(join(repoRoot, "services/platform-api/src/lib.rs"), "utf8"),
  ).length;

  // `\*{0,2}` because the header writes the count in bold: `serves **0 of 40** routes`.
  const claims = [...doc.matchAll(
    /(\d+) of (\d+)\*{0,2}(?: method\+path pairs| contracted operations| routes)/g,
  )];
  assert.ok(claims.length >= 3, `expected the package to state several counts, found ${claims.length}`);

  const wrong = claims.filter((m) => Number(m[2]) !== total).map((m) => m[0]);
  assert.deepEqual(
    wrong,
    [],
    `boundary.md counts against a stale route total (the repo registers ${total}):\n  ` +
      `${wrong.join("\n  ")}\nRun \`node scripts/cutover-readiness.mjs\` and correct the document.`,
  );
});

test("boundary.md's x-unvalidated count is the number the contract actually carries", () => {
  const detail = checkSchemaValidation(
    loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml")),
  ).detail;
  // The detail reads "37 of 40 operations have a validated response schema; 3 are marked
  // x-unvalidated". The leading number is the VALIDATED count — reading it as the unvalidated one
  // is a mistake this comment exists to stop the next reader repeating.
  const live = Number(/(\d+) are marked x-unvalidated/.exec(detail)[1]);
  const claimed = /(\d+) of \d+ contracted operations are `x-unvalidated`/.exec(doc);
  assert.ok(claimed, "the package must state how many operations are x-unvalidated");
  assert.equal(
    Number(claimed[1]),
    live,
    `boundary.md says ${claimed[1]} x-unvalidated operations; the contract carries ${live}`,
  );
});

test("boundary.md does not describe ADR-0022 as unaccepted while it is Accepted", () => {
  // The claim that went stale in the direction that matters least and reads worst: a review package
  // telling a signer there is no rollback story when there is one.
  const adr = checkAdr0022(readFileSync(join(repoRoot, "docs/DECISIONS.md"), "utf8"));
  if (adr.state !== MET) return; // still Proposed — the document's original wording is correct
  assert.doesNotMatch(
    doc,
    /ADR-0022 is \*\*Proposed\*\*/,
    "ADR-0022 is Accepted; the package still calls it Proposed",
  );
  assert.doesNotMatch(
    doc,
    /\*\*No rollback artifact\.\*\*/,
    "a rollback artifact exists; the package still says there is none",
  );
});

test("a refusal is presented as a legitimate outcome", () => {
  // If signing were the only outcome the document contemplates, it would be applying pressure rather
  // than presenting evidence.
  assert.match(doc, /refusal is a legitimate outcome/i);
});

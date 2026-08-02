import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canShowLearnerFacingAiOutput } from "../../packages/contracts/src/index.ts";

/**
 * Two clients, one definition of "safe to show a learner".
 *
 * `apps/web` filters tajweed findings through `canShowLearnerFacingAiOutput`; `apps/flutter` filters
 * them through `TajweedFinding.isLearnerVisible`. They are written in different languages and cannot
 * share code, so nothing except this file stops them drifting — and the two were ALREADY apart when
 * this was written: Dart accepted only `scholar-approved` (rejecting the `teacher-reviewed` findings
 * the web client shows) and had no confidence floor at all (showing a 0.3-confidence approved
 * finding the web client withholds). Each client was stricter than the other in a different
 * direction, and both believed they were enforcing "the" rule.
 *
 * ── How this works, and what it cannot see ────────────────────────────────────────────────────
 * The TypeScript side is EXECUTED — imported and called on every case below, so its real behaviour
 * is the reference. The Dart side cannot be executed from Node, so its three terms are extracted
 * from source and checked two ways:
 *
 *   1. a predicate built from the EXTRACTED values must agree with the executed TS gate on every
 *      case, so changing a Dart constant turns this red;
 *   2. the gate expression must still reference all three terms, so deleting one from the `&&`
 *      chain while leaving the constants in place also turns it red.
 *
 * What it cannot catch: a change to the SHAPE of the Dart expression that keeps all three names but
 * combines them differently (`||` instead of `&&`, a negation). `apps/flutter/test/tajweed_gate_test.dart`
 * executes the real predicate and covers that; this file covers agreement between the two languages.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DART = readFileSync(
  join(here, "..", "..", "apps", "flutter", "lib", "src", "api", "models.dart"),
  "utf8",
);

/** The `const Set<String> learnerApprovedReviewStatuses = <String>{ ... };` literal. */
function dartApprovedStatuses(source) {
  const block = source.match(
    /const Set<String> learnerApprovedReviewStatuses\s*=\s*<String>\{([^}]*)\}/,
  );
  assert.ok(block, "learnerApprovedReviewStatuses is gone from models.dart");
  return new Set([...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]));
}

function dartMinConfidence(source) {
  const found = source.match(/const double learnerMinConfidence\s*=\s*([0-9.]+)\s*;/);
  assert.ok(found, "learnerMinConfidence is gone from models.dart");
  return Number(found[1]);
}

/** The body of `bool get isLearnerVisible => ... ;` */
function dartGateExpression(source) {
  const found = source.match(/bool get isLearnerVisible =>([\s\S]*?);/);
  assert.ok(found, "isLearnerVisible is gone from models.dart");
  return found[1];
}

const APPROVED = dartApprovedStatuses(DART);
const FLOOR = dartMinConfidence(DART);

const SOURCE = { id: "s1", title: "Tajweed rules", citation: "Ch. 4" };

/**
 * Every case is run through BOTH gates. Includes the two divergences that existed before this file:
 * `teacher-reviewed` (Dart used to reject) and a low-confidence approval (Dart used to accept).
 */
const CASES = [
  { reviewStatus: "scholar-approved", confidence: 0.95, sources: [SOURCE] },
  { reviewStatus: "teacher-reviewed", confidence: 0.95, sources: [SOURCE] },
  { reviewStatus: "teacher-reviewed", confidence: 0.3, sources: [SOURCE] },
  { reviewStatus: "scholar-approved", confidence: 0.82, sources: [SOURCE] },
  { reviewStatus: "scholar-approved", confidence: 0.8199, sources: [SOURCE] },
  { reviewStatus: "scholar-approved", confidence: 1, sources: [] },
  { reviewStatus: "ai-suggested", confidence: 1, sources: [SOURCE] },
  { reviewStatus: "teacher-review-required", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "draft", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "blocked", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "scholar_approved", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "SCHOLAR-APPROVED", confidence: 0.99, sources: [SOURCE] },
  { reviewStatus: "teacher-approved", confidence: 0.99, sources: [SOURCE] },
];

/** The Dart gate, rebuilt from the values actually committed in models.dart. */
const dartGate = (f) =>
  APPROVED.has(f.reviewStatus) && f.confidence >= FLOOR && f.sources.length > 0;

test("the Dart and TypeScript learner gates agree on every case", () => {
  const disagreements = CASES.filter((f) => dartGate(f) !== canShowLearnerFacingAiOutput(f)).map(
    (f) =>
      `${JSON.stringify(f.reviewStatus)} conf=${f.confidence} sources=${f.sources.length}: ` +
      `dart=${dartGate(f)} ts=${canShowLearnerFacingAiOutput(f)}`,
  );
  assert.deepEqual(
    disagreements,
    [],
    "apps/flutter and apps/web disagree about what a learner may be shown:\n  " +
      disagreements.join("\n  "),
  );
});

test("the case table actually exercises both answers", () => {
  // A table where every case is false would pass the test above against a gate that always returns
  // false. This is the check that keeps the one above from being decorative.
  const allowed = CASES.filter(canShowLearnerFacingAiOutput);
  assert.ok(allowed.length > 0, "no case is allowed through; the parity test proves nothing");
  assert.ok(allowed.length < CASES.length, "every case is allowed; the gate is not being tested");
});

test("the Dart gate still applies all three terms", () => {
  // Extracted constants agreeing is not enough: `isLearnerVisible => true` would pass the test
  // above while the constants sat unused three lines up.
  const expression = dartGateExpression(DART);
  for (const term of ["learnerApprovedReviewStatuses", "learnerMinConfidence", "sources"]) {
    assert.ok(
      expression.includes(term),
      `isLearnerVisible no longer references ${term}; a learner gate lost one of its three terms:\n${expression}`,
    );
  }
});

/**
 * P3.2 — the gate is now FOUR implementations, not two.
 *
 * `list_session_tajweed_findings` redacts a withheld finding server-side (review.rs
 * `clears_learner_gate`), so Rust holds a copy of the same rule, and `handlers/agent.rs` +
 * `services/node-api/routes/agent-write.mjs` hold a third and fourth for the agent-run gate. Four
 * copies of a safety threshold across three languages is exactly what drifts, and the direction it
 * drifts in is somebody lowering one of them alone.
 *
 * Source-extracted, like the Dart side: Rust cannot be executed from Node either. This asserts the
 * VALUE is the same everywhere, which is the part that silently rots. The behaviour of the Rust
 * predicate is covered by integration.rs, which builds findings on each side of the floor.
 */
const RUST_FILES = [
  ["services", "platform-api", "src", "handlers", "review.rs"],
  ["services", "platform-api", "src", "handlers", "agent.rs"],
];
const NODE_FILES = [
  ["services", "node-api", "routes", "agent-write.mjs"],
  ["services", "node-api", "routes", "ml-proxy.mjs"],
];

test("every implementation of the learner gate uses the same confidence floor", () => {
  const repo = join(here, "..", "..");
  const found = [];

  // The confidence term of the gate, identified by what it is CONJOINED WITH rather than by where
  // it sits in the line: a floor that is not immediately followed by a source term is not this gate.
  // That distinction is load-bearing — `agent-write.mjs` also contains `confidence >= 0 &&
  // confidence <= 1`, a range validation, and an oracle that just skipped the literal `0` would be
  // blind to the single most dangerous mutation there is here, someone setting the floor to zero.
  const GATE = /confidence\s*>=\s*([A-Za-z_0-9.]+)\s*&&\s*(?:source|has_source)/g;

  for (const parts of [...RUST_FILES, ...NODE_FILES]) {
    const file = parts.at(-1);
    const src = readFileSync(join(repo, ...parts), "utf8");
    const consts = Object.fromEntries(
      [...src.matchAll(/const LEARNER_MIN_CONFIDENCE: f64 = ([0-9.]+);/g)].map((m) => [
        "LEARNER_MIN_CONFIDENCE",
        Number(m[1]),
      ]),
    );
    for (const m of src.matchAll(GATE)) {
      const raw = m[1];
      const value = /^[0-9.]+$/.test(raw) ? Number(raw) : consts[raw];
      assert.ok(
        value !== undefined,
        `${file}: the gate compares confidence against \`${raw}\`, which this test cannot resolve ` +
          "to a number — declare it as LEARNER_MIN_CONFIDENCE or inline the literal",
      );
      found.push([file, value]);
    }
  }

  // Per FILE, not a total count: a file may legitimately mention the shape twice (a comment naming
  // it, a second call site). What must never happen is a listed implementation contributing NOTHING
  // — that is the case where this test passes while the gate it was written to pin has been deleted.
  const silent = [...RUST_FILES, ...NODE_FILES]
    .map((parts) => parts.at(-1))
    .filter((file) => !found.some(([f]) => f === file));
  assert.deepEqual(
    silent,
    [],
    `${JSON.stringify(silent)} contain no recognisable learner gate. Either the comparison was ` +
      "rewritten in a shape this cannot see, or it is gone — and a gate this test cannot find is " +
      "a gate it is not pinning.",
  );
  const wrong = found.filter(([, value]) => value !== FLOOR);
  assert.deepEqual(
    wrong,
    [],
    `a server-side confidence floor disagrees with the clients' ${FLOOR}: ` + JSON.stringify(wrong),
  );
});

test("the approval allowlist is an allowlist, in both languages", () => {
  // The failure mode this prevents is specific: a DENYLIST fails open. Any status nobody thought of
  // — a typo, a new one added upstream — would reach a learner. Assert the shape by construction:
  // an invented status must be refused by both.
  const invented = { reviewStatus: "definitely-fine-honest", confidence: 1, sources: [SOURCE] };
  assert.equal(canShowLearnerFacingAiOutput(invented), false);
  assert.equal(dartGate(invented), false);
});

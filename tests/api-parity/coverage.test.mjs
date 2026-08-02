import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * PAR6 — account for all 77 Rust integration tests.
 * specs/api-parity-suite/plan.md §5
 *
 * Same discipline as Phase 5 asserting its 5xx coverage gap *as* a gap: the claim goes stale
 * LOUDLY when someone adds a Rust test, instead of quietly. Without this, "we ported the
 * incident-class tests" silently decays into "we ported the incident-class tests as of July".
 *
 * Deliberately needs NO database and NO binary, so it runs in the hermetic `test: node services`
 * step rather than the DB-gated one — the ledger's correctness has nothing to do with Postgres.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const coverage = JSON.parse(readFileSync(join(here, "coverage.json"), "utf8"));
const rustSource = readFileSync(
  join(repoRoot, "services/platform-api/tests/integration.rs"),
  "utf8",
);

/**
 * Enumerate `#[tokio::test]` / `#[test]` functions, skipping any attributes in between
 * (`#[ignore = "requires live Postgres"]` sits on 67 of them).
 */
function rustTestNames(src) {
  const lines = src.split("\n");
  const names = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#\[(tokio::)?test\]/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && /^#\[/.test(lines[j])) j++;
    const m = /^(?:async )?fn (\w+)/.exec(lines[j]);
    if (m) names.push(m[1]);
  }
  return names;
}

const VALID_STATUSES = new Set(["ported", "deferred-to-phase-7", "mechanical-remainder"]);

test("every Rust integration test is accounted for in coverage.json", () => {
  const rust = rustTestNames(rustSource);
  const ledger = new Set(coverage.tests.map((t) => t.rustTest));

  const missing = rust.filter((n) => !ledger.has(n));
  assert.deepEqual(
    missing,
    [],
    `these Rust tests have no coverage.json entry — add one with a status of ` +
      `${[...VALID_STATUSES].join(" | ")}:\n  ${missing.join("\n  ")}`,
  );
});

test("coverage.json lists no test that no longer exists in integration.rs", () => {
  // The other direction: a renamed or deleted Rust test must not leave a stale row claiming
  // coverage of something that is gone.
  const rust = new Set(rustTestNames(rustSource));
  const stale = coverage.tests.map((t) => t.rustTest).filter((n) => !rust.has(n));
  assert.deepEqual(stale, [], `stale coverage.json entries (renamed or deleted upstream):\n  ${stale.join("\n  ")}`);
});

test("the parser finds the count this ledger was built against", () => {
  // If a future test used a different attribute macro the parser would under-count SILENTLY, and
  // both checks above would pass while covering nothing. Pin the total so that shows up.
  const rust = rustTestNames(rustSource);
  const total = Object.values(coverage.totals).reduce((a, b) => a + b, 0);
  assert.equal(rust.length, total, "parsed test count and ledger total disagree");
  assert.equal(coverage.tests.length, total);
});

test("every entry has a valid status, and the non-ported ones give a reason", () => {
  for (const entry of coverage.tests) {
    assert.ok(
      VALID_STATUSES.has(entry.status),
      `${entry.rustTest}: invalid status ${JSON.stringify(entry.status)}`,
    );
    if (entry.status === "ported") {
      assert.match(entry.parityFile ?? "", /\.test\.mjs$/, `${entry.rustTest}: needs a parityFile`);
    } else {
      // A blank "reason" is how a deferral becomes indistinguishable from an oversight.
      assert.ok(
        (entry.reason ?? "").length > 20,
        `${entry.rustTest}: a non-ported entry needs a real reason, got ${JSON.stringify(entry.reason)}`,
      );
    }
  }
});

test("every ported entry points at a parity file that exists and names its Rust origin", () => {
  const byFile = new Map();
  for (const entry of coverage.tests.filter((t) => t.status === "ported")) {
    if (!byFile.has(entry.parityFile)) {
      byFile.set(entry.parityFile, readFileSync(join(here, entry.parityFile), "utf8"));
    }
    assert.match(
      byFile.get(entry.parityFile),
      new RegExp(`integration\\.rs:\\d+ — ${entry.rustTest}\\b`),
      `${entry.parityFile} must carry a provenance comment for ${entry.rustTest}`,
    );
  }
});

test("the ported count matches the approved scope: 32", () => {
  // Scope B was approved for exactly 26 incident-class tests (plan.md §4). Growing the suite is
  // good — but it should be a visible decision, not a number that drifts.
  //
  // 26 -> 28 (2026-08-01, specs/privacy-job-404/ PJ2): the two privacy-job 404 tests. That is what
  // "a visible decision" means in practice — this line had to be edited, in the same commit, by
  // someone who could say which tests and why.
  //
  // 28 -> 29 (2026-08-02, ADR-0027): teacher_decision_promotes_the_finding_and_edited_promotes_nothing.
  // A teacher decision now UPDATEs tajweed_findings.review_status, in Rust and in the Node port. A
  // port that recorded the review and skipped the promotion would pass every other assertion in
  // db-endpoints.test.mjs, so this one is not optional coverage — it is the behaviour.
  //
  // 29 -> 30 (2026-08-02, ADR-0027 action item 4): the persist + learner-read chain. The route it
  // covers, GET /v1/recitation-sessions/{id}/tajweed-findings, is the first learner-facing read of
  // recitation ANALYSIS — the boundary is ownership, not role, and a role-only check would let any
  // learner in the tenant read any other learner's mistakes.
  //
  // 30 -> 32 (2026-08-02, ADR-0027 item 5): the two finalize tests. That route decides what a
  // person is recorded as having recited, so its ownership boundary is not optional coverage.
  assert.equal(coverage.totals.ported, 32);
  assert.equal(coverage.totals["deferred-to-phase-7"], 5);
});

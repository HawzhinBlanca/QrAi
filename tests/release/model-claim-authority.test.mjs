import assert from "node:assert/strict";
import test from "node:test";

import { selectUniqueReleaseAuthority } from "../../scripts/check-model-eval-claims.mjs";

const ineligible = (id, createdAt) => ({
  id,
  evidenceId: null,
  evidenceEligibility: "fixture-regression",
  releaseEligible: false,
  createdAt,
});

const releaseRow = (id, evidenceId, createdAt, outcome = "valid") => ({
  id,
  evidenceId,
  evidenceEligibility: "release-candidate",
  releaseEligible: true,
  createdAt,
  outcome,
});

function evaluate(row) {
  if (row.outcome !== "valid") throw new Error(`verification refused ${row.id}`);
  return {
    authority: { rowId: row.id, evidenceId: row.evidenceId },
    identity: `${row.evidenceId}:payload:model`,
  };
}

test("newer ineligible history cannot hide an older valid release authority", () => {
  const result = selectUniqueReleaseAuthority(
    [releaseRow("valid", "evidence-a", "2026-01-01"), ineligible("newer-fixture", "2026-02-01")],
    evaluate,
  );
  assert.deepEqual(result, {
    authority: { rowId: "valid", evidenceId: "evidence-a" },
    problem: null,
  });
});

test("older ineligible history cannot hide a newer valid release authority", () => {
  const result = selectUniqueReleaseAuthority(
    [ineligible("old-fixture", "2026-01-01"), releaseRow("valid", "evidence-a", "2026-02-01")],
    evaluate,
  );
  assert.equal(result.authority.rowId, "valid");
  assert.equal(result.problem, null);
});

test("multiple distinct valid authorities are ambiguous and fail closed", () => {
  const result = selectUniqueReleaseAuthority(
    [releaseRow("first", "evidence-a", "2026-01-01"), releaseRow("second", "evidence-b", "2026-02-01")],
    evaluate,
  );
  assert.equal(result.authority, null);
  assert.match(result.problem, /ambiguous|multiple/i);
});

test("an invalid release-labelled row conflicts even when another row is valid", () => {
  const result = selectUniqueReleaseAuthority(
    [releaseRow("valid", "evidence-a", "2026-01-01"), releaseRow("tampered", "evidence-b", "2026-02-01", "invalid")],
    evaluate,
  );
  assert.equal(result.authority, null);
  assert.match(result.problem, /tampered|verification refused/i);
});

test("exact duplicate authority identities do not become false ambiguity", () => {
  const result = selectUniqueReleaseAuthority(
    [releaseRow("tenant-a", "evidence-a", "2026-01-01"), releaseRow("tenant-b", "evidence-a", "2026-01-01")],
    evaluate,
  );
  assert.equal(result.authority.evidenceId, "evidence-a");
  assert.equal(result.problem, null);
});

test("ordinary fixture/research history is ignored and supplies no authority", () => {
  const result = selectUniqueReleaseAuthority(
    [ineligible("fixture", "2026-01-01"), { ...ineligible("research", "2026-02-01"), evidenceEligibility: "research-only" }],
    evaluate,
  );
  assert.deepEqual(result, { authority: null, problem: null });
});

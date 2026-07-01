import { test } from "node:test";
import assert from "node:assert/strict";

import { canShowLearnerFacingAiOutput, statusForRun } from "./lib/gate.mjs";
import { explainRule, runTajweedExplainer, SCHOLAR_BOARD_SOURCE } from "./lib/tajweedExplainer.mjs";
import { runTajweedExplainerBatch } from "./server.mjs";

test("gate blocks AI-suggested output even when confident and sourced", () => {
  assert.equal(
    canShowLearnerFacingAiOutput({ reviewStatus: "ai-suggested", confidence: 0.95, sources: [{ id: "s" }] }),
    false,
  );
});

test("gate allows scholar-approved, confident, sourced output", () => {
  assert.equal(
    canShowLearnerFacingAiOutput({ reviewStatus: "scholar-approved", confidence: 0.9, sources: [{ id: "s" }] }),
    true,
  );
});

test("gate blocks low confidence and unsourced output", () => {
  assert.equal(canShowLearnerFacingAiOutput({ reviewStatus: "teacher-reviewed", confidence: 0.5, sources: [{ id: "s" }] }), false);
  assert.equal(canShowLearnerFacingAiOutput({ reviewStatus: "teacher-reviewed", confidence: 0.95, sources: [] }), false);
});

test("statusForRun routes blocked and gated runs correctly", () => {
  assert.equal(statusForRun({ reviewStatus: "blocked", confidence: 0.99, sources: [{ id: "s" }] }), "blocked");
  assert.equal(statusForRun({ reviewStatus: "ai-suggested", confidence: 0.99, sources: [{ id: "s" }] }), "needs-human-review");
  assert.equal(statusForRun({ reviewStatus: "scholar-approved", confidence: 0.9, sources: [{ id: "s" }] }), "approved");
});

test("explainRule returns real, rule-specific guidance", () => {
  assert.match(explainRule("Makhraj of ع"), /ʿayn|throat/);
  assert.match(explainRule("Tafkhim of ص"), /heavy|mufakhkham|tongue/);
  // Unknown rule falls back without inventing a ruling.
  assert.match(explainRule("Some Novel Rule"), /Some Novel Rule/);
});

test("runTajweedExplainer always gates a fresh candidate to human review + anchors a source", () => {
  const run = runTajweedExplainer({
    id: "finding-1",
    rule: "Makhraj of ع",
    confidence: 0.84,
    sources: [{ id: "tajweed-scholar-board", title: "x", citation: "y" }],
  });
  assert.equal(run.name, "Tajweed Explainer");
  assert.equal(run.reviewStatus, "ai-suggested");
  assert.equal(run.status, "needs-human-review"); // never auto-approved
  assert.equal(run.findingId, "finding-1");
  assert.ok(run.sources.length >= 1);
  // Scholar-board source anchored exactly once (no duplicate).
  assert.equal(run.sources.filter((s) => s.id === SCHOLAR_BOARD_SOURCE.id).length, 1);
});

test("runTajweedExplainerBatch turns findings into recorded runs (injected IO)", async () => {
  const findings = [
    { id: "f1", rule: "Makhraj of ع", confidence: 0.84, sources: [] },
    { id: "f2", rule: "Tafkhim of ص", confidence: 0.79, sources: [] },
  ];
  const written = [];
  const summary = await runTajweedExplainerBatch({
    fetchFindings: async () => findings,
    record: async (run) => {
      written.push(run);
      return { id: `run-${written.length}`, ...run };
    },
  });
  assert.equal(summary.processedFindings, 2);
  assert.equal(summary.created, 2);
  assert.equal(written.length, 2);
  assert.ok(written.every((r) => r.status === "needs-human-review"));
  assert.deepEqual(
    written.map((r) => r.findingId),
    ["f1", "f2"],
  );
});

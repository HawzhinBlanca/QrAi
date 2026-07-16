import { test } from "node:test";
import assert from "node:assert/strict";

import { canShowLearnerFacingAiOutput, statusForRun } from "./lib/gate.mjs";
import { explainRule, runTajweedExplainer, SCHOLAR_BOARD_SOURCE } from "./lib/tajweedExplainer.mjs";
import { summarizePatterns, runMistakePatternSummarizer } from "./lib/mistakePatterns.mjs";
import { recommendNextStep, runPracticeRecommender } from "./lib/practiceRecommender.mjs";
import {
  runTajweedExplainerBatch,
  runMistakePatternSummarizerBatch,
  runPracticeRecommenderBatch,
  runAllAgents,
  server,
} from "./server.mjs";

/** Fire a real HTTP request at the exported server (no listen() call in tests, so this
 *  binds an ephemeral port itself and tears it down after). */
async function request(method, path, headers = {}) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...headers, connection: "close" },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

test("gate fails CLOSED on an unrecognized reviewStatus, not open", () => {
  // Mirrors packages/contracts' equivalent regression test (PR #57): this must be an allowlist,
  // not a denylist of known-bad statuses — otherwise a typo or a future reviewStatus value this
  // module doesn't recognize would silently pass through as "approved for learner display."
  assert.equal(
    canShowLearnerFacingAiOutput({ reviewStatus: "under-review", confidence: 0.99, sources: [{ id: "s" }] }),
    false,
  );
});

test("statusForRun routes blocked and gated runs correctly", () => {
  assert.equal(statusForRun({ reviewStatus: "blocked", confidence: 0.99, sources: [{ id: "s" }] }), "blocked");
  assert.equal(statusForRun({ reviewStatus: "ai-suggested", confidence: 0.99, sources: [{ id: "s" }] }), "needs-human-review");
  assert.equal(statusForRun({ reviewStatus: "teacher-review-required", confidence: 0.99, sources: [{ id: "s" }] }), "needs-human-review");
  assert.equal(statusForRun({ reviewStatus: "scholar-approved", confidence: 0.9, sources: [{ id: "s" }] }), "approved");
  assert.equal(
    statusForRun({ reviewStatus: "under-review", confidence: 0.99, sources: [{ id: "s" }] }),
    "needs-human-review",
    "an unrecognized status must never resolve to approved",
  );
});

test("explainRule returns real, rule-specific guidance", () => {
  assert.match(explainRule("Makhraj of ع"), /ʿayn|throat/);
  assert.match(explainRule("Tafkhim of ص"), /heavy|mufakhkham|tongue/);
  // Unknown rule falls back without inventing a ruling.
  assert.match(explainRule("Some Novel Rule"), /Some Novel Rule/);
});

test("explainRule does not mismatch on bare Arabic letters shared across rules (regression)", () => {
  // ن and م appear in almost every tajweed rule string (and in most Arabic words generally);
  // they must not act as a catch-all match for ghunnah. Bug: a madd/waqf finding whose text
  // happened to contain م or ن was previously mislabeled as ghunnah guidance.
  assert.match(explainRule("Madd rule involving the letter م in a lengthened context"), /madd|elongation/i);
  assert.doesNotMatch(explainRule("Waqf (stopping) on the word الرحمن"), /ghunnah/i);
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
    fetchExisting: async () => [], // no prior runs -> nothing to dedup
    record: async (run) => {
      written.push(run);
      return { id: `run-${written.length}`, ...run };
    },
  });
  assert.equal(summary.processedFindings, 2);
  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 0);
  assert.equal(written.length, 2);
  assert.ok(written.every((r) => r.status === "needs-human-review"));
  assert.deepEqual(
    written.map((r) => r.findingId),
    ["f1", "f2"],
  );
});

test("runTajweedExplainerBatch skips findings that already have an agent run (dedup)", async () => {
  // Regression guard: every batch tick used to re-explain and re-record EVERY finding, growing
  // agent_runs unboundedly and spamming the teacher review queue with duplicates. A finding that
  // already has a recorded run (matched by findingId) must be skipped.
  const findings = [
    { id: "f1", rule: "Makhraj of ع", confidence: 0.84, sources: [] },
    { id: "f2", rule: "Tafkhim of ص", confidence: 0.79, sources: [] },
  ];
  const written = [];
  const summary = await runTajweedExplainerBatch({
    fetchFindings: async () => findings,
    fetchExisting: async () => [{ id: "run-old", findingId: "f1" }], // f1 already processed
    record: async (run) => {
      written.push(run);
      return { id: `run-${written.length}`, ...run };
    },
  });
  assert.equal(summary.processedFindings, 2);
  assert.equal(summary.created, 1, "only the un-processed finding is recorded");
  assert.equal(summary.skipped, 1);
  assert.deepEqual(
    written.map((r) => r.findingId),
    ["f2"],
    "f1 (already had a run) is skipped; only f2 is recorded",
  );
});

test("runTajweedExplainerBatch skips findings with no id (can't be deduped → would re-run forever)", async () => {
  // An id-less finding can never be recorded in the dedup set, so if it were processed it would be
  // re-explained and re-recorded on EVERY tick — unbounded agent_runs growth. It must be skipped.
  const findings = [
    { rule: "Makhraj of ع", confidence: 0.84, sources: [] }, // no id
    { id: "f2", rule: "Tafkhim of ص", confidence: 0.79, sources: [] },
  ];
  const written = [];
  const summary = await runTajweedExplainerBatch({
    fetchFindings: async () => findings,
    fetchExisting: async () => [],
    record: async (run) => {
      written.push(run);
      return { id: `run-${written.length}`, ...run };
    },
  });
  assert.equal(summary.created, 1, "only the id-bearing finding is recorded");
  assert.equal(summary.skipped, 1, "the id-less finding is skipped, not processed");
  assert.deepEqual(written.map((r) => r.findingId), ["f2"]);
});

// --- Mistake Pattern Summarizer ---------------------------------------------

test("summarizePatterns ranks recurring rules by frequency", () => {
  const findings = [
    { rule: "Makhraj of ع", severity: "major", confidence: 0.9 },
    { rule: "makhraj of ع", severity: "major", confidence: 0.8 }, // same rule, case-insensitive
    { rule: "Ghunnah", severity: "minor", confidence: 0.7 },
  ];
  const patterns = summarizePatterns(findings);
  assert.equal(patterns[0].rule, "Makhraj of ع");
  assert.equal(patterns[0].count, 2);
  assert.equal(patterns[0].avgConfidence, 0.85);
  assert.equal(patterns[0].severity, "major");
  assert.equal(patterns[1].rule, "Ghunnah");
});

test("runMistakePatternSummarizer emits one gated, sourced summary; null for no findings", () => {
  assert.equal(runMistakePatternSummarizer([]), null);
  const run = runMistakePatternSummarizer([
    { rule: "Ghunnah", severity: "minor", confidence: 0.7 },
    { rule: "Ghunnah", severity: "minor", confidence: 0.8 },
  ]);
  assert.equal(run.name, "Mistake Pattern Summarizer");
  assert.equal(run.reviewStatus, "ai-suggested");
  assert.equal(run.status, "needs-human-review"); // never auto-approved
  assert.ok(run.sources.length >= 1);
  assert.match(run.lastEvent, /Ghunnah/);
});

test("runMistakePatternSummarizerBatch records one run (injected IO)", async () => {
  const written = [];
  const summary = await runMistakePatternSummarizerBatch({
    fetchFindings: async () => [{ rule: "Madd", severity: "major", confidence: 0.75 }],
    record: async (run) => {
      written.push(run);
      return { id: "run-1", ...run };
    },
  });
  assert.equal(summary.created, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].name, "Mistake Pattern Summarizer");
});

// --- Practice Plan Recommender ----------------------------------------------

const NOW = "2026-07-01T12:00:00Z";

test("recommendNextStep chooses by session count, due date, mastery, and streak", () => {
  assert.match(recommendNextStep({ totalSessions: 0 }, NOW).headline, /Start/);
  assert.match(
    recommendNextStep({ totalSessions: 3, nextReviewAt: "2026-06-30T12:00:00Z" }, NOW).headline,
    /due/i,
  );
  assert.match(recommendNextStep({ totalSessions: 3, mastery: 0.2, nextReviewAt: "2026-07-05T12:00:00Z" }, NOW).headline, /accuracy/i);
  assert.match(recommendNextStep({ totalSessions: 3, mastery: 0.8, streak: 0, nextReviewAt: "2026-07-05T12:00:00Z" }, NOW).headline, /streak/i);
  assert.match(recommendNextStep({ totalSessions: 3, mastery: 0.8, streak: 4, nextReviewAt: "2026-07-05T12:00:00Z" }, NOW).headline, /memory/i);
});

test("runPracticeRecommender gates a sourced recommendation to review", () => {
  const run = runPracticeRecommender({ learnerId: "learner-1", totalSessions: 3, mastery: 0.25, nextReviewAt: "2026-07-05T12:00:00Z" }, NOW);
  assert.equal(run.name, "Practice Plan Recommender");
  assert.equal(run.reviewStatus, "ai-suggested");
  assert.equal(run.status, "needs-human-review");
  assert.match(run.goal, /learner-1/);
  assert.ok(run.sources.length >= 1);
});

test("runPracticeRecommenderBatch fans out over active learners (injected IO)", async () => {
  const written = [];
  const summary = await runPracticeRecommenderBatch({
    fetchLearnerIds: async () => ["learner-1", "learner-2"],
    fetchProgress: async (id) => ({ learnerId: id, totalSessions: 2, mastery: 0.3, streak: 1, nextReviewAt: "2026-07-05T12:00:00Z" }),
    record: async (run) => {
      written.push(run);
      return { id: `run-${written.length}`, ...run };
    },
    now: NOW,
  });
  assert.equal(summary.processedLearners, 2);
  assert.equal(summary.created, 2);
  assert.ok(written.every((r) => r.name === "Practice Plan Recommender"));
});

test("batch runners tolerate a non-array upstream (no 'not iterable' crash)", async () => {
  // A malformed upstream that returns an object (HTTP 200) must mean "no items", not throw.
  const tj = await runTajweedExplainerBatch({ fetchFindings: async () => ({ oops: true }), fetchExisting: async () => [], record: async () => ({}) });
  assert.equal(tj.created, 0);
  const mp = await runMistakePatternSummarizerBatch({ fetchFindings: async () => null, record: async () => ({}) });
  assert.equal(mp.created, 0);
  const pr = await runPracticeRecommenderBatch({ fetchLearnerIds: async () => "not-an-array", fetchProgress: async () => ({}), record: async () => ({}), now: NOW });
  assert.equal(pr.created, 0);
});

// --- HTTP-level auth gate ----------------------------------------------------

test("GET /health requires no auth", async () => {
  const { status, body } = await request("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.service, "agents");
});

test("POST /run* without the api key is rejected, does not run agents", async () => {
  for (const path of ["/run", "/run/tajweed", "/run/mistakes", "/run/recommend"]) {
    const { status, body } = await request("POST", path);
    assert.equal(status, 401, `${path} should require x-agents-api-key`);
    assert.equal(body.error, "unauthorized");
  }
});

test("POST /run* with the wrong api key is rejected", async () => {
  const { status } = await request("POST", "/run", { "x-agents-api-key": "wrong-key" });
  assert.equal(status, 401);
});

test("runAllAgents aggregates every agent's runs (injected IO)", async () => {
  const noop = async (run) => ({ id: "x", ...run });
  const result = await runAllAgents({
    tajweed: { fetchFindings: async () => [{ id: "f1", rule: "Ghunnah", confidence: 0.8, sources: [] }], fetchExisting: async () => [], record: noop },
    mistakes: { fetchFindings: async () => [{ rule: "Ghunnah", severity: "minor", confidence: 0.8 }], record: noop },
    recommend: {
      fetchLearnerIds: async () => ["learner-1"],
      fetchProgress: async (id) => ({ learnerId: id, totalSessions: 1, mastery: 0.1 }),
      record: noop,
      now: NOW,
    },
  });
  assert.equal(result.agents.length, 3);
  assert.equal(result.created, 3); // 1 explainer + 1 summary + 1 recommendation
});

// The source/review gate — a faithful mirror of `canShowLearnerFacingAiOutput` in
// packages/contracts. Agents are supervised tools, NOT religious authorities: a freshly
// generated answer is never shown to a learner until it is human-reviewed AND sourced.

const BLOCKING_REVIEW_STATES = new Set(["blocked", "draft", "ai-suggested", "teacher-review-required"]);

/**
 * @param {{ reviewStatus: string, confidence: number, sources: unknown[] }} record
 * @returns {boolean} whether this output may be shown directly to a learner.
 */
export function canShowLearnerFacingAiOutput(record) {
  if (BLOCKING_REVIEW_STATES.has(record.reviewStatus)) {
    return false;
  }
  const sourceCount = Array.isArray(record.sources) ? record.sources.length : 0;
  return record.confidence >= 0.82 && sourceCount > 0;
}

/** Resolve an agent-run lifecycle status from the gate. */
export function statusForRun(record) {
  if (record.reviewStatus === "blocked") return "blocked";
  return canShowLearnerFacingAiOutput(record) ? "approved" : "needs-human-review";
}

// The source/review gate — a faithful mirror of `canShowLearnerFacingAiOutput` in
// packages/contracts. Agents are supervised tools, NOT religious authorities: a freshly
// generated answer is never shown to a learner until it is human-reviewed AND sourced.

// Allowlist, not a denylist — matches packages/contracts/src/index.ts's
// canShowLearnerFacingAiOutput exactly (PR #57: a denylist of known-unapproved statuses fails
// OPEN for any reviewStatus it doesn't recognize, letting unreviewed content through; an
// allowlist fails CLOSED). This module's own callers (tajweedExplainer.mjs,
// practiceRecommender.mjs, mistakePatterns.mjs) all currently hardcode reviewStatus to the
// literal "ai-suggested", so today this can't yet produce a wrong result either way — but that's
// exactly the situation the contracts fix addressed: a plain string literal with no schema
// enforcement, one typo or one future agent module away from silently approving unreviewed output.
const APPROVED_REVIEW_STATES = new Set(["teacher-reviewed", "scholar-approved"]);

/**
 * @param {{ reviewStatus: string, confidence: number, sources: unknown[] }} record
 * @returns {boolean} whether this output may be shown directly to a learner.
 */
export function canShowLearnerFacingAiOutput(record) {
  if (!APPROVED_REVIEW_STATES.has(record.reviewStatus)) {
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

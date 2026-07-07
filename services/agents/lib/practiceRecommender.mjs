// Practice Plan Recommender agent — turns a learner's real SM-2 progress into a concrete
// "what to practice next" recommendation. Deterministic (rule-based on due date / mastery /
// streak), sourced, and gated: emitted "ai-suggested" so a teacher confirms it before it
// drives learner-facing guidance.

import { statusForRun } from "./gate.mjs";

export const SPACED_REPETITION_SOURCE = {
  id: "sm2-review-policy",
  title: "Quran AI Spaced-Repetition Policy",
  citation: "Internal SM-2 review scheduling policy",
};

/**
 * Decide the next practice step from a learner's progress (pure).
 * @param {{ mastery?: number, streak?: number, totalSessions?: number, nextReviewAt?: string|null }} progress
 * @param {string} nowIso  current time (ISO); injected so the function stays pure/testable
 * @returns {{ headline: string, reason: string }}
 */
export function recommendNextStep(progress, nowIso) {
  const mastery = Number(progress?.mastery ?? 0);
  const streak = Number(progress?.streak ?? 0);
  const totalSessions = Number(progress?.totalSessions ?? 0);
  const now = Date.parse(nowIso);
  const due = progress?.nextReviewAt ? Date.parse(progress.nextReviewAt) : NaN;

  if (totalSessions === 0) {
    return {
      headline: "Start with a short listen-then-recite session on Al-Faatiha.",
      reason: "No sessions yet — begin with the guided listen → recite loop to establish a baseline.",
    };
  }
  if (Number.isFinite(due) && Number.isFinite(now) && due <= now) {
    return {
      headline: "Review the ayahs that are due today before learning anything new.",
      reason: "Spaced-repetition items are due — reviewing them now protects retention and your streak.",
    };
  }
  if (mastery < 0.5) {
    return {
      headline: "Do one focused guided-recite pass to raise accuracy.",
      reason: `Mastery is ${Math.round(mastery * 100)}% — steady guided practice builds it fastest.`,
    };
  }
  if (streak === 0) {
    return {
      headline: "Restart your streak with a short recite-from-memory session.",
      reason: "The daily streak has lapsed — a brief session today gets it going again.",
    };
  }
  return {
    headline: "Try a memory-recite pass to deepen mastery.",
    reason: `Mastery is ${Math.round(mastery * 100)}% with a ${streak}-day streak — you're ready to stretch.`,
  };
}

/**
 * Produce an agent-run candidate recommending a learner's next practice step.
 * @param {{ learnerId?: string } & object} progress
 * @param {string} nowIso
 */
export function runPracticeRecommender(progress, nowIso) {
  const rec = recommendNextStep(progress, nowIso);
  const learnerId = progress?.learnerId ?? null;
  // Rule-based on real SM-2 data → high confidence. Still "ai-suggested" for human review.
  const confidence = 0.9;
  const reviewStatus = "ai-suggested";
  const sources = [SPACED_REPETITION_SOURCE];
  const status = statusForRun({ reviewStatus, confidence, sources });

  return {
    name: "Practice Plan Recommender",
    goal: `Recommend the next practice step for ${learnerId ?? "the learner"}.`,
    status,
    confidence,
    reviewStatus,
    sources,
    lastEvent: `${rec.headline} ${rec.reason}`,
    findingId: null,
    // Structured learner reference so platform-api can persist it into agent_runs.learner_id —
    // without this, the ONLY place the learner's id lives is embedded as free text in `goal`
    // above, which the privacy-delete erasure cascade has no way to search or scope a DELETE
    // against. A learner's requested erasure would otherwise leave their id in this table forever.
    learnerId,
  };
}

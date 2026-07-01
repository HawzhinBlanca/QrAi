// Mistake Pattern Summarizer agent — aggregates the tenant's tajweed findings into the
// most common recurring mistakes so a teacher can see cohort-wide patterns at a glance.
// Deterministic (pure counting), sourced, and gated: the summary is emitted "ai-suggested"
// so it must pass human review (lib/gate.mjs) before any learner-facing use.

import { statusForRun } from "./gate.mjs";

export const COHORT_INSIGHT_SOURCE = {
  id: "cohort-insight-policy",
  title: "Quran AI Cohort Insight Policy",
  citation: "Internal reviewed policy for aggregate mistake reporting",
};

/**
 * Aggregate findings into ranked recurring patterns (pure).
 * @param {Array<{ rule?: string, severity?: string, confidence?: number }>} findings
 * @param {number} topN
 * @returns {Array<{ rule: string, count: number, avgConfidence: number, severity: string }>}
 */
export function summarizePatterns(findings, topN = 5) {
  const groups = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const rule = String(finding.rule || "unknown").trim() || "unknown";
    const key = rule.toLowerCase();
    const group = groups.get(key) || { rule, count: 0, confidenceSum: 0, severities: {} };
    group.count += 1;
    group.confidenceSum += Number(finding.confidence ?? 0);
    const severity = String(finding.severity || "unspecified");
    group.severities[severity] = (group.severities[severity] || 0) + 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({
      rule: g.rule,
      count: g.count,
      avgConfidence: Math.round((g.confidenceSum / g.count) * 100) / 100,
      // The severity that occurs most often for this rule.
      severity: Object.entries(g.severities).sort((a, b) => b[1] - a[1])[0][0],
    }))
    // Most frequent first; ties broken by higher average confidence.
    .sort((a, b) => b.count - a.count || b.avgConfidence - a.avgConfidence)
    .slice(0, Math.max(0, topN));
}

function renderSummary(patterns, total) {
  const lines = patterns.map(
    (p, i) =>
      `${i + 1}. ${p.rule} — ${p.count}× (${p.severity}, avg confidence ${Math.round(
        p.avgConfidence * 100,
      )}%)`,
  );
  return `Across ${total} tajweed findings, the most common recurring issues are:\n${lines.join("\n")}`;
}

/**
 * Produce a single agent-run candidate summarizing the cohort's mistake patterns.
 * Returns null when there are no findings (nothing to summarize).
 * @param {Array<object>} findings
 */
export function runMistakePatternSummarizer(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return null;

  const patterns = summarizePatterns(list);
  // Deterministic statistical summary → high confidence in the aggregate itself. Still
  // "ai-suggested", so the gate routes it to human review regardless.
  const confidence = 0.86;
  const reviewStatus = "ai-suggested";
  const sources = [COHORT_INSIGHT_SOURCE];
  const status = statusForRun({ reviewStatus, confidence, sources });

  return {
    name: "Mistake Pattern Summarizer",
    goal: "Summarize the cohort's most common tajweed mistakes for teacher review.",
    status,
    confidence,
    reviewStatus,
    sources,
    lastEvent: renderSummary(patterns, list.length),
    findingId: null,
  };
}

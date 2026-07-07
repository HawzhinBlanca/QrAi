// Tajweed Explainer agent — turns a tajweed finding into a learner-facing explanation
// candidate. Deterministic and grounded in a fixed knowledge base of tajweed rules plus
// the internal scholar-board policy source; it does NOT invent rulings. Every candidate
// is emitted with reviewStatus "ai-suggested" so it must pass the human review gate
// (see lib/gate.mjs) before a learner ever sees it.

import { statusForRun } from "./gate.mjs";

export const SCHOLAR_BOARD_SOURCE = {
  id: "tajweed-scholar-board",
  title: "Quran AI Scholar Board",
  citation: "Internal reviewed tajweed explanation policy",
};

// Rule keyword -> canonical, review-safe explanation. Matched case-insensitively on a
// substring of the finding's `rule` so classifier wording variations still resolve.
const KNOWLEDGE = [
  {
    match: ["makhraj", "ayn", "throat"],
    explanation:
      "The letter ʿayn (ع) is articulated from the middle of the throat. Aim for a clear, open throat sound and avoid letting it drift toward the softer ghayn (غ).",
  },
  {
    match: ["tafkhim", "sad", "heavy", "mufakhkham"],
    explanation:
      "Ṣād (ص) is a heavy (mufakhkham) letter: raise the back of the tongue and keep the sound full and rounded rather than thin.",
  },
  {
    match: ["ghunnah", "nasal"],
    explanation:
      "Apply ghunnah — a two-count nasal resonance held in the nose — on the noon or meem where the rule requires it, without clipping it short.",
  },
  {
    match: ["madd", "elongation", "lengthen"],
    explanation:
      "This madd (elongation) should be held for its full count. Sustain the vowel steadily and evenly rather than cutting it off early.",
  },
  {
    match: ["qalqalah", "echo", "bounce"],
    explanation:
      "Give the qalqalah letter a light echoing bounce when it carries a sukoon, without adding a full vowel after it.",
  },
  {
    match: ["idgham", "merge", "assimilat"],
    explanation:
      "Merge (idghām) the two letters smoothly into one articulation as the rule requires, keeping any accompanying ghunnah for its full measure.",
  },
  {
    match: ["ikhfa", "hide", "conceal"],
    explanation:
      "Partially conceal (ikhfāʾ) the noon sound with a light nasal ghunnah as you transition into the following letter — neither a full noon nor a full merge.",
  },
];

/** @param {string} rule */
export function explainRule(rule) {
  const needle = String(rule || "").toLowerCase();
  const hit = KNOWLEDGE.find((entry) => entry.match.some((token) => needle.includes(token.toLowerCase())));
  if (hit) return hit.explanation;
  return `Focus on the tajweed rule "${rule}" for this word. Practise it slowly and confirm the articulation with your teacher.`;
}

/**
 * Produce an agent-run candidate for a single tajweed finding.
 * @param {{ id?: string, rule: string, severity?: string, confidence?: number, sources?: unknown[] }} finding
 */
export function runTajweedExplainer(finding) {
  const confidence = Math.min(0.99, Math.max(0, Number(finding.confidence ?? 0.7)));
  // Reuse the finding's own sources (already source-attributed) and always anchor to the
  // scholar-board policy so the citation set is never empty.
  const findingSources = Array.isArray(finding.sources) ? finding.sources : [];
  const sources = [SCHOLAR_BOARD_SOURCE, ...findingSources.filter((s) => s && s.id !== SCHOLAR_BOARD_SOURCE.id)];
  // Freshly generated → must be human-reviewed before it is learner-facing.
  const reviewStatus = "ai-suggested";
  const status = statusForRun({ reviewStatus, confidence, sources });

  return {
    name: "Tajweed Explainer",
    goal: `Explain "${finding.rule}" for the learner without issuing a religious ruling.`,
    status,
    confidence,
    reviewStatus,
    sources,
    lastEvent: explainRule(finding.rule),
    findingId: finding.id ?? null,
  };
}

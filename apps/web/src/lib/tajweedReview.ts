import { canShowLearnerFacingAiOutput } from "@quran-ai/contracts";

import type { TajweedFinding } from "./api";

/**
 * The learner surface must never receive a finding until it clears the shared
 * platform gate: human review, sufficient confidence, and a source citation.
 * Keep the original findings for the authenticated review workflow; this only
 * selects the subset that is safe to present as learning guidance.
 */
export function learnerVisibleTajweedFindings(findings: TajweedFinding[]): TajweedFinding[] {
  return findings.filter(canShowLearnerFacingAiOutput);
}

/**
 * The badge a learner sees for an already eligible tajweed finding. The guard above
 * prevents unreviewed findings from entering this surface; the badge remains
 * defensive so a future caller cannot accidentally label an ineligible finding verified.
 */
export function tajweedReviewBadge(
  finding: Pick<TajweedFinding, "confidence" | "reviewStatus" | "sources">,
): { verified: boolean; labelKey: string } {
  const verified = canShowLearnerFacingAiOutput(finding);
  return {
    verified,
    // Plain function, no React context to call useTranslation() from -- returns a translation KEY
    // (not the literal label) for TajweedPanel.tsx to pass through t().
    labelKey: verified ? "tajweedPanel.verified" : "tajweedPanel.aiSuggestion",
  };
}

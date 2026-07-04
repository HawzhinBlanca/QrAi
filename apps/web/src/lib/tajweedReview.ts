import { canShowLearnerFacingAiOutput } from "@quran-ai/contracts";

import type { TajweedFinding } from "./api";

/**
 * The badge a learner sees for a tajweed finding. Live practice output is `ai-suggested` (not yet
 * human-reviewed), so it is shown but honestly labeled as provisional — never presented as verified.
 * A finding only reads as "verified" once it clears the platform's real learner-facing gate
 * (`canShowLearnerFacingAiOutput`: teacher-reviewed / scholar-approved, confident, and sourced).
 */
export function tajweedReviewBadge(
  finding: Pick<TajweedFinding, "confidence" | "reviewStatus" | "sources">,
): { verified: boolean; label: string } {
  const verified = canShowLearnerFacingAiOutput(finding);
  return {
    verified,
    label: verified ? "Verified" : "AI suggestion · not yet reviewed",
  };
}

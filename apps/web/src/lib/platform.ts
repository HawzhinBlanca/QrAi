import { canShowLearnerFacingAiOutput } from "@quran-ai/contracts";
import type { AgentRun, ScholarApproval, SourceReference, SupportedLanguageCode } from "../types/platform";

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function requiresHumanReview(agentRun: AgentRun): boolean {
  return (
    agentRun.status === "needs-human-review" ||
    agentRun.reviewStatus === "ai-suggested" ||
    agentRun.confidence < 0.82
  );
}

export function canShowLearnerFacingAnswer(agentRun: AgentRun): boolean {
  if (agentRun.status === "blocked") {
    return false;
  }

  return canShowLearnerFacingAiOutput(agentRun);
}

export function summarizeScholarQueue(approvals: ScholarApproval[]) {
  return approvals.reduce(
    (summary, approval) => {
      summary.total += 1;
      summary[approval.status] += 1;
      if (approval.risk === "high") {
        summary.highRisk += 1;
      }
      return summary;
    },
    { total: 0, draft: 0, "scholar-approved": 0, blocked: 0, highRisk: 0 },
  );
}

export function getSourceCoverage(sources: SourceReference[]): "missing" | "partial" | "covered" {
  if (sources.length === 0) {
    return "missing";
  }

  return sources.length >= 2 ? "covered" : "partial";
}

export function getLanguageDirection(language: SupportedLanguageCode): "ltr" | "rtl" {
  return language === "ar" || language === "ckb" || language === "ur" ? "rtl" : "ltr";
}

import { canShowLearnerFacingAiOutput } from "@quran-ai/contracts";
import type { AgentRun, ScholarApproval, SourceReference, SupportedLanguageCode } from "../types/platform";

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// Narrowed to the fields actually read, so both the rich contract types and the
// lightweight API-result shapes (see data/platform.ts) satisfy these helpers.
type AgentRunGate = Pick<AgentRun, "status" | "reviewStatus" | "confidence" | "sources">;

export function requiresHumanReview(agentRun: Pick<AgentRunGate, "status" | "reviewStatus" | "confidence">): boolean {
  return (
    agentRun.status === "needs-human-review" ||
    agentRun.reviewStatus === "ai-suggested" ||
    agentRun.confidence < 0.82
  );
}

export function canShowLearnerFacingAnswer(agentRun: AgentRunGate): boolean {
  if (agentRun.status === "blocked") {
    return false;
  }

  return canShowLearnerFacingAiOutput(agentRun);
}

export function summarizeScholarQueue(approvals: Array<Pick<ScholarApproval, "status" | "risk">>) {
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

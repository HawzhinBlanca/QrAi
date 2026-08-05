import { canShowLearnerFacingAiOutput } from "@quran-ai/contracts";
import type { AgentRun, ScholarApproval, SourceReference } from "../types/platform";

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// Narrowed to the fields actually read, so both the rich contract types and the
// lightweight API-result shapes (see data/platform.ts) satisfy these helpers.
type AgentRunGate = Pick<AgentRun, "status" | "reviewStatus" | "confidence" | "sources">;

export function canShowLearnerFacingAnswer(agentRun: AgentRunGate): boolean {
  if (agentRun.status === "blocked") {
    return false;
  }

  return canShowLearnerFacingAiOutput(agentRun);
}

/**
 * Is this run waiting on a person?
 *
 * Defined as the COMPLEMENT of the gate rather than as its own list of conditions. It used to be the
 * latter, and it was the only denylist among the implementations of this rule — every other one
 * (packages/contracts, handlers/review.rs, services/agents, services/node-api, apps/flutter) is an
 * allowlist, each carrying a comment explaining that a denylist fails OPEN on any status it has not
 * heard of. This one read:
 *
 *     status === "needs-human-review" || reviewStatus === "ai-suggested" ||
 *     reviewStatus === "teacher-review-required" || confidence < 0.82
 *
 * so an unrecognised `reviewStatus` — a typo, or one added server-side without updating this file —
 * came back `false`: no human needed. It also held the repository's tenth copy of `0.82`.
 *
 * It was never a content hole. `PlatformCommand` falls through to `canShowLearnerFacingAnswer`,
 * which is a correct allowlist, so an unknown status still rendered "blocked" rather than "safe".
 * What it produced was wrong LABELS on a staff console, always understating that a human is needed:
 * an approved run missing a source read as a dead end instead of a task, and a blocked run with low
 * confidence read as work waiting for a teacher.
 *
 * Deriving it from the gate removes the second list, removes the duplicated constant, and makes the
 * fail-closed direction automatic: anything the gate will not approve is somebody's job.
 */
export function requiresHumanReview(agentRun: AgentRunGate): boolean {
  // Blocked is a decision, not a queue. Checked first because the gate refuses blocked runs too, and
  // without this every one of them would report as awaiting review.
  if (agentRun.status === "blocked") {
    return false;
  }
  // The one thing the gate cannot see: it reads reviewStatus/confidence/sources and never `status`,
  // so a run explicitly parked for review with an otherwise-clean record would look settled.
  if (agentRun.status === "needs-human-review") {
    return true;
  }
  return !canShowLearnerFacingAnswer(agentRun);
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

// `getLanguageDirection(language)` was here and is deleted. It had ZERO callers.
//
// Its test asserted it "is the single call that decides that" for right-to-left rendering, which was
// not true of the running app: direction is set per element by literal `dir="rtl"` attributes, in
// QuranReader.tsx, TajweedPanel.tsx and IssuePanel.tsx, alongside a literal `lang` (`ar` for
// canonical text, `ckb` for the Sorani translation). App.tsx:379 records why — those blocks carry
// their own `dir` and styles.css uses CSS logical properties throughout.
//
// So the helper was dead code kept alive by a test, and the test's comment claimed responsibility
// for behaviour it had no part in. Deleting both; the note stays so the next person looking for
// "where is direction decided" finds the answer rather than the helper.

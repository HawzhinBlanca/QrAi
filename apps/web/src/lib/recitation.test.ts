import { describe, expect, it } from "vitest";
import { getQuranVerses, buildRecitationEvents } from "../data/quran";
import { createWaveform, flattenWords, nextActiveWordIndex, summarizeSession } from "./recitation";
import {
  canShowLearnerFacingAnswer,
  formatPercent,
  getLanguageDirection,
  requiresHumanReview,
  summarizeScholarQueue,
} from "./platform";
import { agentRuns, scholarApprovals } from "../data/platform";

describe("recitation helpers", () => {
  it("summarizes flagged words into a stable coaching score", () => {
    const recitationEvents = buildRecitationEvents([
      { wordId: "1:5:4", canonicalText: "نَسْتَعِينُ", heardText: "نَسْتَغِينُ", status: "misread", confidence: 0.84 },
      { wordId: "1:6:2", canonicalText: "الصِّرَاطَ", heardText: "السِّرَاطَ", status: "needs-review", confidence: 0.79 },
      { wordId: "1:7:4", canonicalText: "عَلَيْهِمْ", heardText: "", status: "missed", confidence: 0.3 },
    ]);
    const summary = summarizeSession(getQuranVerses(), recitationEvents);

    expect(summary.totalWords).toBe(29);
    expect(summary.correctWords).toBe(26);
    expect(summary.accuracy).toBe(90);
    expect(summary.mistakes).toBe(1);
    expect(summary.needsWork).toBe(1);
    expect(summary.missed).toBe(1);
  });

  it("generates deterministic waveform bars for repeatable UI tests", () => {
    expect(createWaveform(7, 4)).toEqual([45, 28, 44, 35]);
  });

  it("wraps the active word cursor", () => {
    const words = flattenWords(getQuranVerses());

    expect(nextActiveWordIndex(words.length - 1, words.length)).toBe(0);
    expect(nextActiveWordIndex(0, words.length)).toBe(1);
  });

  it("keeps agent answers behind source and review gates", () => {
    const approvedRun = agentRuns.find((run) => run.status === "approved");
    const blockedRun = agentRuns.find((run) => run.status === "blocked");
    const reviewRun = agentRuns.find((run) => run.status === "needs-human-review");

    expect(approvedRun && canShowLearnerFacingAnswer(approvedRun)).toBe(true);
    expect(blockedRun && canShowLearnerFacingAnswer(blockedRun)).toBe(false);
    expect(reviewRun && requiresHumanReview(reviewRun)).toBe(true);
  });

  it("summarizes scholar review state for governance dashboards", () => {
    expect(summarizeScholarQueue(scholarApprovals)).toEqual({
      total: 3,
      draft: 1,
      "scholar-approved": 1,
      blocked: 1,
      highRisk: 1,
    });
  });

  it("formats platform display helpers consistently", () => {
    expect(formatPercent(0.913)).toBe("91%");
    expect(getLanguageDirection("ckb")).toBe("rtl");
    expect(getLanguageDirection("fr")).toBe("ltr");
  });
});

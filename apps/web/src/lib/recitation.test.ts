import { describe, expect, it } from "vitest";
import { getQuranVerses, buildRecitationEvents } from "../data/quran";
import type { WordStatus } from "../data/quran";
import { createWaveform, flattenWords, nextActiveWordIndex, summarizeSession } from "./recitation";
import {
  canShowLearnerFacingAnswer,
  formatPercent,
  getLanguageDirection,
  requiresHumanReview,
  summarizeScholarQueue,
} from "./platform";

describe("recitation helpers", () => {
  it("summarizes flagged words into a stable coaching score", () => {
    const recitationEvents = buildRecitationEvents([
      { wordId: "1:5:4", canonicalText: "نَسْتَعِينُ", heardText: "نَسْتَغِينُ", status: "misread", confidence: 0.84 },
      { wordId: "1:6:2", canonicalText: "الصِّرَاطَ", heardText: "السِّرَاطَ", status: "needs-review", confidence: 0.79 },
      { wordId: "1:7:4", canonicalText: "عَلَيْهِمْ", heardText: "", status: "missed", confidence: 0.3 },
    ]);
    // Simulate the post-recitation verse state (3 flagged words) as a local fixture —
    // the canonical verses themselves carry no fabricated statuses.
    const flaggedStatuses: Record<string, WordStatus> = {
      "1:5:4": "mistake",
      "1:6:2": "needs-work",
      "1:7:4": "missed",
    };
    const verses = getQuranVerses().map((verse) => ({
      ...verse,
      words: verse.words.map((word) => ({ ...word, status: flaggedStatuses[word.id] ?? word.status })),
    }));
    const summary = summarizeSession(verses, recitationEvents);

    expect(summary.totalWords).toBe(29);
    expect(summary.correctWords).toBe(26);
    expect(summary.accuracy).toBe(90);
    expect(summary.mistakes).toBe(1);
    expect(summary.needsWork).toBe(1);
    expect(summary.missed).toBe(1);
  });

  it("reports 0% accuracy (not NaN) when there are no words", () => {
    // Empty verses (e.g. the passage hasn't loaded) must not divide 0/0 → NaN, which renders "NaN%".
    const summary = summarizeSession([], []);
    expect(summary.totalWords).toBe(0);
    expect(summary.correctWords).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(Number.isNaN(summary.accuracy)).toBe(false);
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
    const approvedRun: Parameters<typeof canShowLearnerFacingAnswer>[0] = {
      status: "approved",
      reviewStatus: "teacher-reviewed",
      confidence: 0.86,
      sources: [{ id: "quran-foundation", title: "Quran Foundation API", citation: "Canonical text" }],
    };
    const blockedRun: Parameters<typeof canShowLearnerFacingAnswer>[0] = {
      status: "blocked",
      reviewStatus: "blocked",
      confidence: 0.97,
      sources: [],
    };
    const reviewRun: Parameters<typeof requiresHumanReview>[0] = {
      status: "needs-human-review",
      reviewStatus: "ai-suggested",
      confidence: 0.78,
    };
    const teacherReviewRequiredRun: Parameters<typeof requiresHumanReview>[0] = {
      status: "approved",
      reviewStatus: "teacher-review-required",
      confidence: 0.95,
    };

    expect(canShowLearnerFacingAnswer(approvedRun)).toBe(true);
    expect(canShowLearnerFacingAnswer(blockedRun)).toBe(false);
    expect(requiresHumanReview(reviewRun)).toBe(true);
    expect(requiresHumanReview(teacherReviewRequiredRun)).toBe(true);
  });

  it("summarizes scholar review state for governance dashboards", () => {
    const approvals: Parameters<typeof summarizeScholarQueue>[0] = [
      { status: "scholar-approved", risk: "low" },
      { status: "draft", risk: "medium" },
      { status: "blocked", risk: "high" },
    ];

    expect(summarizeScholarQueue(approvals)).toEqual({
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

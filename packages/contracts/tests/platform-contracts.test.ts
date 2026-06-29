import { describe, expect, it } from "vitest";
import {
  CORE_TABLES,
  EVENT_SUBJECTS,
  PUBLIC_API_ROUTES,
  canUseExternalAsr,
  canShowLearnerFacingAiOutput,
  createCanonicalChecksum,
  hasCanonicalTextChanged,
  modelEvalPassesReleaseGate,
  mustDiscardAudio,
  verifyCanonicalWord,
  type AgentRun,
  type CanonicalWordRecord,
  type ConsentSnapshot,
  type ModelEvalRun,
  type QuranReference,
  type RealtimeSessionTicket,
} from "../src";

const fatihahRef: QuranReference = {
  surahNumber: 1,
  ayahStart: 1,
  ayahEnd: 1,
  wordStart: 1,
  wordEnd: 1,
  display: "Al-Fatihah 1:1:1",
};

describe("Quran AI platform contracts", () => {
  it("locks the public API surface from the 10/10 architecture plan", () => {
    expect(PUBLIC_API_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/recitation-sessions",
      "GET /v1/recitation-sessions/:id",
      "POST /v1/realtime-session-tickets",
      "WS /v1/recitation-sessions/:id/audio",
      "POST /v1/teacher-reviews",
      "GET /v1/teacher-review-queue",
      "POST /v1/scholar-approvals",
      "GET /v1/eval-runs/:modelVersion",
      "POST /v1/privacy/export",
      "POST /v1/privacy/delete",
    ]);
  });

  it("locks event subjects and storage tables required for proof gates", () => {
    expect(EVENT_SUBJECTS).toContain("recitation.alignment.partial");
    expect(EVENT_SUBJECTS).toContain("privacy.external-asr.called");
    expect(EVENT_SUBJECTS).toContain("audit.security.event");
    expect(CORE_TABLES).toContain("canonical_words");
    expect(CORE_TABLES).toContain("agent_runs");
    expect(CORE_TABLES).toContain("consent_records");
    expect(CORE_TABLES).toContain("realtime_session_tickets");
    expect(CORE_TABLES).toContain("privacy_jobs");
  });

  it("detects modified canonical Quran text through checksum verification", () => {
    const checksumInput = {
      id: "1:1:1",
      quranRef: fatihahRef,
      ayahId: "1:1",
      wordIndex: 1,
      text: "بِسْمِ",
      sourceId: "tanzil" as const,
      edition: "uthmani-v1",
      scriptType: "uthmani" as const,
      importVersion: "2026-06-24-seed",
    };
    const canonicalWord: CanonicalWordRecord = {
      ...checksumInput,
      sourceChecksum: createCanonicalChecksum(checksumInput),
    };
    const modifiedWord: CanonicalWordRecord = {
      ...canonicalWord,
      text: "بسم",
    };

    expect(verifyCanonicalWord(canonicalWord)).toBe(true);
    expect(verifyCanonicalWord(modifiedWord)).toBe(false);
    expect(hasCanonicalTextChanged(canonicalWord, modifiedWord)).toBe(true);
  });

  it("blocks learner-facing AI output without sources, confidence, or human review", () => {
    const approvedRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      confidence: 0.91,
      reviewStatus: "teacher-reviewed",
      sources: [{ id: "scholar-board", title: "Scholar Board", citation: "Approved tajweed note" }],
    };
    const unsourcedRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      ...approvedRun,
      sources: [],
    };
    const draftRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      ...approvedRun,
      reviewStatus: "draft",
    };
    const weakRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      ...approvedRun,
      confidence: 0.78,
    };

    expect(canShowLearnerFacingAiOutput(approvedRun)).toBe(true);
    expect(canShowLearnerFacingAiOutput(unsourcedRun)).toBe(false);
    expect(canShowLearnerFacingAiOutput(draftRun)).toBe(false);
    expect(canShowLearnerFacingAiOutput(weakRun)).toBe(false);
  });

  it("keeps discard-mode audio out of storage paths", () => {
    expect(mustDiscardAudio("discard")).toBe(true);
    expect(mustDiscardAudio("teacher-review")).toBe(false);
    expect(mustDiscardAudio("training-opt-in")).toBe(false);
  });

  it("requires explicit guardian-approved consent before external ASR", () => {
    const consent: ConsentSnapshot = {
      audioRetention: "discard",
      anonymizedLearning: true,
      externalAsrProcessing: true,
      guardianApproved: true,
      consentVersion: "pilot-v1",
    };

    expect(canUseExternalAsr(consent)).toBe(true);
    expect(canUseExternalAsr({ ...consent, externalAsrProcessing: false })).toBe(false);
    expect(canUseExternalAsr({ ...consent, guardianApproved: false })).toBe(false);
  });

  it("requires realtime tickets to carry signed session, tenant, learner, expiry, and consent fields", () => {
    const ticket: RealtimeSessionTicket = {
      sessionId: "session-1",
      tenantId: "tenant-1",
      learnerId: "learner-1",
      expiresAt: "1782426600",
      allowedSampleRates: [16000, 48000],
      externalAsrProcessing: true,
      token: "rt_v1.session-1.tenant-1.learner-1.true.1782426600.nonce.signature",
    };

    expect(ticket.token.startsWith("rt_v1.")).toBe(true);
    expect(ticket.tenantId).toBe("tenant-1");
    expect(ticket.learnerId).toBe("learner-1");
    expect(ticket.externalAsrProcessing).toBe(true);
    expect(ticket.allowedSampleRates).toContain(16000);
  });

  it("locks the full ML release threshold before learner-facing ship", () => {
    const passingEval: ModelEvalRun = {
      modelVersion: "model-v1",
      datasetVersion: "fatihah-juz-amma-reviewed-v1",
      wordAlignmentF1: 0.91,
      tajweedF1: 0.84,
      falsePositiveRate: 0.06,
      teacherAgreementRate: 0.92,
      unsourcedLearnerOutputs: 0,
      passed: true,
    };

    expect(modelEvalPassesReleaseGate(passingEval)).toBe(true);
    expect(modelEvalPassesReleaseGate({ ...passingEval, wordAlignmentF1: 0.89 })).toBe(false);
    expect(modelEvalPassesReleaseGate({ ...passingEval, falsePositiveRate: 0.081 })).toBe(false);
    expect(modelEvalPassesReleaseGate({ ...passingEval, teacherAgreementRate: 0.89 })).toBe(false);
    expect(modelEvalPassesReleaseGate({ ...passingEval, unsourcedLearnerOutputs: 1 })).toBe(false);
    expect(modelEvalPassesReleaseGate({ ...passingEval, passed: false })).toBe(false);
  });
});

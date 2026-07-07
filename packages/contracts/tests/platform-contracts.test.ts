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
  sha256Hex,
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
      "POST /v1/ml/alignments:predict",
      "POST /v1/ml/tajweed-findings:predict",
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

    // New checksums use sha256: prefix
    expect(canonicalWord.sourceChecksum.startsWith("sha256:")).toBe(true);
  });

  it("computes real SHA-256 (NIST known-answer vectors), not just a self-consistent hash", () => {
    // The checksum tests above only prove the hash CHANGES with the input — a subtly-broken hash would
    // pass them while pinning its own wrong output. These NIST FIPS 180-4 vectors prove sha256Hex is
    // genuinely SHA-256, so `sha256:` is honest and the canonical-content pins match any real tool.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56-byte input forces the two-block padding path.
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // Arabic (multi-byte UTF-8) — the bismillah word (12 UTF-8 bytes) — vs the digest of its bytes.
    expect(sha256Hex("بِسْمِ")).toBe("1c562fd4a7951a03c69ed9f9a10f9423120f439d4fea482d35f3a5c6062dc006");
  });

  it("accepts legacy fnv1a32 checksums from existing seed data", () => {
    // This is the pre-upgrade checksum for the same canonical word record.
    // If this test fails, existing seed SQL data would silently fail verification.
    const legacyWord: CanonicalWordRecord = {
      id: "1:1:1",
      quranRef: fatihahRef,
      ayahId: "1:1",
      wordIndex: 1,
      text: "بِسْمِ",
      sourceId: "tanzil" as const,
      edition: "uthmani-v1",
      scriptType: "uthmani" as const,
      importVersion: "2026-06-24-seed",
      sourceChecksum: "fnv1a32:785efc35",
    };

    expect(verifyCanonicalWord(legacyWord)).toBe(true);

    // Tampered text should still fail with legacy checksum
    const tamperedLegacy: CanonicalWordRecord = { ...legacyWord, text: "بسم" };
    expect(verifyCanonicalWord(tamperedLegacy)).toBe(false);
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
    const teacherReviewRequiredRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      ...approvedRun,
      reviewStatus: "teacher-review-required",
    };
    const weakRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      ...approvedRun,
      confidence: 0.78,
    };

    expect(canShowLearnerFacingAiOutput(approvedRun)).toBe(true);
    expect(canShowLearnerFacingAiOutput(unsourcedRun)).toBe(false);
    expect(canShowLearnerFacingAiOutput(draftRun)).toBe(false);
    expect(canShowLearnerFacingAiOutput(teacherReviewRequiredRun)).toBe(false);
    expect(canShowLearnerFacingAiOutput(weakRun)).toBe(false);
  });

  it("also allows scholar-approved output through the gate (not just teacher-reviewed)", () => {
    const scholarApprovedRun: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> = {
      confidence: 0.9,
      reviewStatus: "scholar-approved",
      sources: [{ id: "scholar-board", title: "Scholar Board", citation: "Approved tajweed note" }],
    };
    expect(canShowLearnerFacingAiOutput(scholarApprovedRun)).toBe(true);
  });

  it("fails CLOSED on an unrecognized reviewStatus, not open", () => {
    // reviewStatus is a closed TypeScript union at compile time, but its runtime value on both
    // AgentRun and TajweedFinding is deserialized from an HTTP JSON response (services/ml-inference
    // sets it via a plain JS string literal, with no server-side schema enforcement) — a typo or a
    // future status value added upstream, with this gate not updated to match, would arrive here as
    // an unrecognized string. The gate must treat that as "not approved," never as "not explicitly
    // blocked, so allow it" — the cast below simulates exactly that runtime mismatch.
    const unrecognizedStatusRun = {
      confidence: 0.99,
      reviewStatus: "under-review" as unknown as AgentRun["reviewStatus"],
      sources: [{ id: "scholar-board", title: "Scholar Board", citation: "Approved tajweed note" }],
    };
    expect(canShowLearnerFacingAiOutput(unrecognizedStatusRun)).toBe(false);
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

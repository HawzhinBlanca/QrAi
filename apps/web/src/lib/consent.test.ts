import { describe, expect, it } from "vitest";
import { canRecordRecitation, canUseExternalSpeechFallback } from "./consent";
import type { RecitationConsent } from "./api";

const baseConsent: RecitationConsent = {
  recordingConsent: false,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "test-v1",
};

describe("consent privacy boundaries", () => {
  it("requires explicit external ASR consent and guardian approval for browser speech fallback", () => {
    expect(canUseExternalSpeechFallback(baseConsent)).toBe(false);
    expect(canUseExternalSpeechFallback({ ...baseConsent, externalAsrProcessing: true })).toBe(false);
    expect(canUseExternalSpeechFallback({ ...baseConsent, guardianApproved: true })).toBe(false);
    expect(
      canUseExternalSpeechFallback({
        ...baseConsent,
        externalAsrProcessing: true,
        guardianApproved: true,
      }),
    ).toBe(true);
  });

  it("requires explicit recording consent before the primary Quran-ASR path may record", () => {
    // Default (no consent) must NOT allow recording — the gate the primary path previously lacked.
    // Retention / anonymized / guardian settings do not by themselves grant recording consent.
    expect(canRecordRecitation(baseConsent)).toBe(false);
    expect(canRecordRecitation({ ...baseConsent, audioRetention: "teacher-review" })).toBe(false);
    expect(canRecordRecitation({ ...baseConsent, guardianApproved: true })).toBe(false);
    // Only the explicit opt-in grants it.
    expect(canRecordRecitation({ ...baseConsent, recordingConsent: true })).toBe(true);
  });
});

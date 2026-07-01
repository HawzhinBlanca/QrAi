import { describe, expect, it } from "vitest";
import { canUseExternalSpeechFallback } from "./consent";
import type { RecitationConsent } from "./api";

const baseConsent: RecitationConsent = {
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
});

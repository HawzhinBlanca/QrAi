import type { RecitationConsent } from "./api";

export function canUseExternalSpeechFallback(consent: RecitationConsent): boolean {
  return consent.externalAsrProcessing && consent.guardianApproved;
}

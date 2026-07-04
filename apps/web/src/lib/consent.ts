import type { RecitationConsent } from "./api";

/** Whether the learner has affirmatively consented to record and analyze their recitation. Gates the
 *  primary (first-party Quran ASR) recording path, which previously recorded with no consent check. */
export function canRecordRecitation(consent: RecitationConsent): boolean {
  return consent.recordingConsent === true;
}

export function canUseExternalSpeechFallback(consent: RecitationConsent): boolean {
  return consent.externalAsrProcessing && consent.guardianApproved;
}

/**
 * Pure, framework-free session helpers for the mobile app.
 *
 * These deliberately import NOTHING from react-native / expo, so they are unit-testable with plain
 * node (see session.test.ts) even without the Expo toolchain installed. App.tsx consumes them.
 */

export interface MobileActor {
  userId: string;
  tenantId: string;
  /** JWT from login; empty string when unauthenticated. */
  token: string;
}

/**
 * Actor auth headers for the platform API: a Bearer token once logged in, otherwise the header-auth
 * fallback (which the API only honors when ALLOW_HEADER_AUTH is set — dev/CI). Empty when no user.
 */
export function authHeaders(user: Pick<MobileActor, "userId" | "tenantId" | "token"> | null): Record<string, string> {
  if (user?.token) return { authorization: `Bearer ${user.token}` };
  if (user) return { "x-tenant-id": user.tenantId, "x-user-id": user.userId, "x-user-role": "learner" };
  return {};
}

/** Recording is blocked until the learner affirmatively consents — never assumed. */
export function canStartRecording(recordingConsent: boolean): boolean {
  return recordingConsent === true;
}

/** Split ASR text into recognized words, robust to null/undefined/whitespace. */
export function parseRecognizedText(text: unknown): string[] {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export interface MobileConsent {
  recordingConsent: boolean;
  audioRetention: "discard";
  anonymizedLearning: boolean;
  externalAsrProcessing: boolean;
  guardianApproved: boolean;
  consentVersion: string;
}

/**
 * The consent payload sent to the backend. It reflects the learner's ACTUAL toggle state — there is
 * no hardcoded `guardianApproved: true` (the bug an earlier sweep caught in the mobile app).
 */
export function buildConsentPayload(recordingConsent: boolean, guardianApproved: boolean): MobileConsent {
  return {
    recordingConsent,
    audioRetention: "discard",
    anonymizedLearning: true,
    externalAsrProcessing: false,
    guardianApproved,
    consentVersion: "mobile-v1",
  };
}

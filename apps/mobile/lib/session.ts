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

/** Audio container formats the platform-api ASR proxy accepts (mirrors the server whitelist). */
const ALLOWED_AUDIO_FORMATS = ["m4a", "webm", "wav", "mp3"];

/**
 * The audio container format to report to the ASR proxy, derived from the ACTUAL recording URI
 * rather than a hardcoded platform guess. expo-av's HIGH_QUALITY preset writes `.m4a` on BOTH ios
 * and android (only its web preset is webm), so the old `Platform.OS === "ios" ? "m4a" : "webm"`
 * mislabeled every Android recording as webm — which worked only because the server's ffmpeg
 * content-sniffs, and would break the moment any decoder trusted the extension. Deriving from the
 * real file extension keeps the label tied to the bytes; unknown/absent extensions fall back to
 * m4a (what the native HIGH_QUALITY preset actually produces).
 */
export function audioFormatFromUri(uri: string): string {
  const ext = uri.split("?")[0].split(".").pop()?.toLowerCase();
  return ext && ALLOWED_AUDIO_FORMATS.includes(ext) ? ext : "m4a";
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

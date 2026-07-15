/**
 * Platform API client — talks to the real Postgres-backed Rust API.
 */

import type { ReviewStatus, SourceReference } from "@quran-ai/contracts";

import { fetchWithTimeout } from "./http";

// In dev (vite serves on 5173, the API on 8080) an absolute URL is required. In the Docker/prod
// build, nginx proxies /v1/ to platform-api directly (nginx.conf), so a RELATIVE path is required
// instead — an absolute http://127.0.0.1:8080 both bypasses that proxy (wrong origin in a
// multi-host deployment) and trips the CSP's `connect-src 'self'` (a cross-origin fetch target).
const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8080" : "");

function actorHeaders(tenantId: string, userId: string, role: string, authToken?: string): Record<string, string> {
  if (authToken) {
    return {
      authorization: `Bearer ${authToken}`,
    };
  }
  return {
    "x-tenant-id": tenantId,
    "x-user-id": userId,
    "x-user-role": role,
  };
}

/** Result of a privacy export/delete job (subset of the backend PrivacyJob). */
export interface PrivacyJobResult {
  kind: "export" | "delete";
  includedRecords: string[];
  deletedRecords: string[];
  audioObjectKeysDeleted: string[];
}

/**
 * Export the learner's OWN data (right-of-access). The backend reports which records are held
 * (includedRecords) and deletes nothing. Authz: require_self_or_any, so a learner may export only
 * their own learnerId.
 */
export async function exportMyData(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
}): Promise<PrivacyJobResult> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/privacy/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({ learnerId: params.userId }),
  });
  if (!response.ok) throw new Error(`Export ${response.status}`);
  return response.json() as Promise<PrivacyJobResult>;
}

/**
 * Delete the learner's OWN data and recordings (right-to-erasure). Erases the raw audio from the
 * ML service AND cascades the derived DB records. Irreducibly destructive — callers must confirm
 * first. Authz: require_self_or_any (own learnerId only).
 */
export async function deleteMyData(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
}): Promise<PrivacyJobResult> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/privacy/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({ learnerId: params.userId }),
  });
  if (!response.ok) throw new Error(`Delete ${response.status}`);
  return response.json() as Promise<PrivacyJobResult>;
}

export interface SurahInfo {
  surahNumber: number;
  ayahCount: number;
  name: string;
  arabicName?: string;
  translation?: string;
  revelationType?: string;
}

export interface AyahWord {
  id: string;
  wordIndex: number;
  text: string;
  sourceChecksum: string;
}

export interface AyahInfo {
  id: string;
  surahNumber: number;
  ayahNumber: number;
  text: string;
  sourceChecksum: string;
  words: AyahWord[];
}

export interface SurahDetail {
  surahNumber: number;
  ayahs: Array<{
    id: string;
    surahNumber: number;
    ayahNumber: number;
    text: string;
    sourceChecksum: string;
  }>;
}

export interface AlignmentResult {
  wordId: string;
  canonicalText: string;
  heardText: string;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
  confidence: number;
}

export interface TajweedFinding {
  wordId: string;
  rule: string;
  arabicName: string;
  category: string;
  severity: "practice" | "warning" | "critical";
  explanation: string;
  confidence: number;
  /** Review state of this finding — "ai-suggested" for live practice output (not yet human-reviewed). */
  reviewStatus: ReviewStatus;
  sources: SourceReference[];
}

export interface RecitationConsent {
  /** Affirmative consent to record and analyze the recitation. Required before any recording starts;
   *  the local Quran ASR still processes the audio and it may be stored per audioRetention. */
  recordingConsent: boolean;
  audioRetention: "discard" | "teacher-review" | "training-opt-in";
  anonymizedLearning: boolean;
  externalAsrProcessing: boolean;
  guardianApproved: boolean;
  consentVersion: string;
}

export interface CreatedSession {
  id: string;
  tenantId: string;
  learnerId: string;
}

/**
 * Create a real recitation session (persisted, with the learner's actual consent choices).
 * The returned id is used for the alignment/tajweed calls so the session is traceable.
 */
export async function createRecitationSession(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  learnerId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
  language: string;
  consent: RecitationConsent;
}): Promise<CreatedSession> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/recitation-sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      learnerId: params.learnerId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
      sourceChecksum: "tanzil:uthmani:v1",
      modelVersion: "model-v0.3",
      language: params.language,
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: params.consent,
    }),
  });
  if (!response.ok) {
    throw new Error(`Create session ${response.status}`);
  }
  return response.json() as Promise<CreatedSession>;
}

/**
 * Learner-initiated "send to teacher": asks the backend to flip the learner's OWN session to
 * teacher-review-required so it genuinely enters the teacher's review pipeline. The UI must only
 * claim "sent" after this resolves — the previous implementation flipped a local UI step and
 * displayed "Sent to teacher." without any request at all (SHIP_PLAN P1.2).
 */
export async function requestTeacherReview(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
}): Promise<void> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    localStorage.setItem("smoke-session-id", params.sessionId);
    return Promise.resolve();
  }
  const response = await fetchWithTimeout(
    `${API_BASE}/v1/recitation-sessions/${encodeURIComponent(params.sessionId)}/request-teacher-review`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Request teacher review ${response.status}`);
  }
}

/**
 * Persist a session's computed alignment so it reaches `word_alignments` and becomes visible
 * in the Command console (which reads real alignment, not just seeded demo rows). Synthetic
 * "extra" words are dropped server-side. Best-effort: callers fire-and-forget.
 */
/** Per-word start/end (ms) from forced alignment, keyed by canonical wordId. */
export interface WordTimingMs {
  startMs: number;
  endMs: number;
}

export async function persistSessionAlignments(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  alignments: AlignmentResult[];
  modelVersion?: string;
  /** Real per-word timings from forced alignment (T3); a word absent here persists 0/0 as before. */
  timingsByWordId?: Map<string, WordTimingMs>;
}): Promise<{ persisted: number; skippedInvalidStatus: number; skippedUnknownWord: number }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/v1/recitation-sessions/${encodeURIComponent(params.sessionId)}/alignments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
      },
      body: JSON.stringify({
        modelVersion: params.modelVersion ?? "model-v0.3",
        alignments: params.alignments.map((a) => {
          const t = params.timingsByWordId?.get(a.wordId);
          return {
            wordId: a.wordId,
            heardText: a.heardText ?? "",
            startMs: t?.startMs ?? 0,
            endMs: t?.endMs ?? 0,
            confidence: a.confidence,
            status: a.status,
          };
        }),
      }),
    },
  );
  if (!response.ok) throw new Error(`Persist alignments ${response.status}`);
  return response.json() as Promise<{
    persisted: number;
    skippedInvalidStatus: number;
    skippedUnknownWord: number;
  }>;
}

export interface ForceAlignWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
  score: number;
}

/**
 * Forced alignment (T3): send the recitation audio + the canonical `transcript` (words in wordId
 * order) to the platform API's ASR force-align proxy; get back one {start,end} per transcript word,
 * in order. Best-effort — callers treat a failure/absence as "no timings" and persist 0/0 as before.
 */
export async function forceAlign(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  audioBase64: string;
  audioFormat: string;
  transcript: string;
}): Promise<ForceAlignWord[]> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/asr/force-align`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      audioBase64: params.audioBase64,
      audioFormat: params.audioFormat,
      transcript: params.transcript,
    }),
  });
  if (!response.ok) throw new Error(`Force align ${response.status}`);
  const data = (await response.json()) as { words?: ForceAlignWord[] };
  return data.words ?? [];
}

/**
 * Map forced-alignment spans back to word ids by POSITION. The force-align endpoint returns exactly
 * one span per whitespace token of the transcript, in order, so `aligned[i]` corresponds to
 * `recitedAligned[i]` — but ONLY when the counts match. If the transcript tokenized to a different
 * count (e.g. a canonicalText with internal whitespace, or an empty one), the indices no longer line
 * up and mapping by position would misattribute every subsequent word's timing. In that case bail
 * (return undefined) so the caller persists 0/0 rather than wrong timings — the T3 "degrade safely"
 * guarantee. Callers must pass only words actually recited (exclude "missed"/"extra"), since the
 * aligner is asked to place exactly these words in the audio.
 */
export function buildTimingsByWordId(
  recitedAligned: Pick<AlignmentResult, "wordId">[],
  aligned: ForceAlignWord[],
): Map<string, WordTimingMs> | undefined {
  if (aligned.length !== recitedAligned.length) return undefined;
  const map = new Map<string, WordTimingMs>();
  recitedAligned.forEach((a, i) => {
    const w = aligned[i];
    if (w && w.end > w.start) {
      map.set(a.wordId, { startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) });
    }
  });
  return map;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetchWithTimeout(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${path}`);
  }
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${path}`);
  }
  return response.json();
}

export async function fetchSurahList(): Promise<SurahInfo[]> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve([
      { surahNumber: 1, name: "الفاتحة", englishName: "Al-Fatihah", ayahCount: 7, revelationType: "meccan" }
    ]);
  }
  return fetchJson("/v1/quran/surahs") as Promise<SurahInfo[]>;
}

export async function fetchSurah(surahNumber: number): Promise<SurahDetail> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve({
      surahNumber: 1,
      name: "الفاتحة",
      englishName: "Al-Fatihah",
      ayahCount: 7,
      revelationType: "meccan",
      ayahs: [
        { id: "1:1", surahNumber: 1, ayahNumber: 1, text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ", sourceChecksum: "tanzil:uthmani:v1" },
        { id: "1:2", surahNumber: 1, ayahNumber: 2, text: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ", sourceChecksum: "tanzil:uthmani:v1" }
      ]
    });
  }
  return fetchJson(`/v1/quran/surahs/${surahNumber}`) as Promise<SurahDetail>;
}

export async function fetchAyah(surahNumber: number, ayahNumber: number): Promise<AyahInfo> {
  return fetchJson(`/v1/quran/ayahs/${surahNumber}/${ayahNumber}`) as Promise<AyahInfo>;
}

export async function predictAlignment(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
  recognizedText?: string[];
}): Promise<{ alignments: AlignmentResult[]; confidence: number }> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve({
      alignments: [
        { wordId: "1:1:1", canonicalText: "بِسْمِ", heardText: "بِسْمِ", startMs: 0, endMs: 500, confidence: 0.95, status: "matched" },
        { wordId: "1:1:2", canonicalText: "اللَّهِ", heardText: "الْلَّهَ", startMs: 500, endMs: 1000, confidence: 0.85, status: "misread" }
      ],
      confidence: 0.95
    });
  }
  const response = await fetchWithTimeout(`${API_BASE}/v1/ml/alignments:predict`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
      ...(params.recognizedText ? { recognizedText: params.recognizedText } : {}),
    }),
  });
  if (!response.ok) throw new Error(`ML alignment ${response.status}`);
  return response.json();
}

export async function predictTajweed(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
}): Promise<{ findings: TajweedFinding[]; confidence: number }> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve({
      findings: [
        {
          wordId: "1:1:1",
          rule: "Ghunnah",
          arabicName: "غنة",
          category: "ghunnah",
          severity: "warning",
          explanation: "Ghunnah on Mushaddad",
          confidence: 0.85,
          reviewStatus: "teacher-review-required",
          sources: []
        }
      ],
      confidence: 0.85
    });
  }
  const response = await fetchWithTimeout(`${API_BASE}/v1/ml/tajweed-findings:predict`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
    }),
  });
  if (!response.ok) throw new Error(`ML tajweed ${response.status}`);
  return response.json();
}

